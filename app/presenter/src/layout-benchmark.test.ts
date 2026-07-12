import { describe, it, expect } from 'vitest';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import type { LayoutDesign, LayoutGroup, LayoutNode, LayoutWire, Placement } from './layout-model';
import { DEFAULT_NODE_SIZE, groupRects, nodeGeoms } from './layout-model';
import { LAYOUT_TERMS, LAYOUT_WEIGHTS, TERM_KIND, type LayoutScore, layoutGeometry, scoreLayout, separationMetrics, straightWireCount } from './layout-objective';
import { MIN_PORT_GAP, acceptedPortOffsets, minAssignedPortGap } from './layout-ports';
import { semanticLayout } from './layout-semantic';
import { optimizeLayout } from './layout-optimize';
import { tidyLayout } from './layout';
import { auditDesignEdges, orthogonalPathD, routeDesignEdges, type Pos } from './edge-routing';

// THE BENCHMARK — "najlepsi" made a MEASURED claim, not a felt one. For each committed
// design we lay it out four ways — raw Tidy, dagre, elkjs (layered) and SDA-ideal — route ALL of them with the SAME
// deterministic router, and score ALL of them with the SAME objective (§2). The engines that SHIP are Tidy +
// SDA-ideal only; dagre/elkjs are test-only devDependencies of THIS harness (never a runtime dep — the
// "dependency-free layout" invariant holds). The output is one metric table per design: on the GENERIC terms
// (crossings/bends/length) SDA ties or edges the generic engines; on the SEMANTIC terms (lane/role/symmetry/async)
// SDA wins BY CONSTRUCTION, because dagre/ELK cannot even score them — they threw the meaning away before layout.
//
// The SDA-only comparison (Tidy vs semantic vs optimizer) runs ALWAYS and gates monotone improvement. The four-way
// comparison against dagre/ELK + the SVG previews run only under RUN_LAYOUT_BENCH=1 (so CI stays decoupled from
// third-party layout output); that pass prints the full table and regenerates before/after previews.

interface Raw {
  instances: { id: string; type: string; config?: Record<string, number> }[];
  wires: { from: [string, string]; to: [string, string]; semantics?: 'sync' | 'async' }[];
  groups?: { id: string; members: string[] }[];
  layout?: Record<string, { x: number; y: number }>;
}
const readRaw = (file: string): Raw => JSON.parse(readFileSync(new URL(`../../../examples/${file}`, import.meta.url), 'utf8')) as Raw;
function load(file: string): LayoutDesign {
  const raw = readRaw(file);
  const nodes: LayoutNode[] = raw.instances.map((i) => {
    const origin = i.config?.assumedRps;
    return origin !== undefined ? { id: i.id, type: i.type, originRate: origin } : { id: i.id, type: i.type };
  });
  const wires: LayoutWire[] = raw.wires.map((w) => (w.semantics !== undefined ? { from: w.from, to: w.to, semantics: w.semantics } : { from: w.from, to: w.to }));
  const groups: LayoutGroup[] = (raw.groups ?? []).map((g) => ({ id: g.id, members: g.members }));
  return { nodes, wires, groups };
}

const EXAMPLES = ['cqrs.sda.json', 'ecommerce-production.sda.json', 'cqrs-production-large.sda.json', 'oracle-to-aurora-migration-repeat.sda.json'];
const SIZE = DEFAULT_NODE_SIZE;
const sizesFor = (d: LayoutDesign): Record<string, { w: number; h: number }> => {
  const s: Record<string, { w: number; h: number }> = {};
  for (const n of d.nodes) s[n.id] = SIZE;
  return s;
};
const tidyOf = (d: LayoutDesign): Placement => {
  const groups = d.groups.map((g) => ({ id: g.id, label: '', rect: { x: 0, y: 0, w: 0, h: 0 }, members: g.members }));
  return tidyLayout(d.nodes.map((x) => ({ id: x.id })), d.wires.map((w) => ({ from: w.from, to: w.to })), groups, sizesFor(d)).pos;
};
const fmt = (p: number | null): string => (p === null ? ' N/A' : p.toFixed(2));

describe('layout benchmark — SDA (Tidy vs semantic vs optimizer), always on', () => {
  it('the optimizer beats or ties Tidy on every committed example (the measured floor claim)', () => {
    const lines: string[] = [];
    lines.push('\nSDA aggregate quality (1 = ideal, higher is better):');
    lines.push('design                                 tidy   semantic  optimize   Δ vs tidy');
    for (const f of EXAMPLES) {
      const d = load(f);
      const tidy = scoreLayout(d, tidyOf(d));
      const sem = scoreLayout(d, semanticLayout(d, sizesFor(d)));
      const opt = optimizeLayout(d, { seed: 1, budgetMs: 3000, sizes: sizesFor(d) });
      expect(opt.score.quality, `${f}: optimize ≥ tidy`).toBeGreaterThanOrEqual(tidy.quality - 1e-9);
      lines.push(
        `${f.replace('.sda.json', '').padEnd(38)} ${tidy.quality.toFixed(3)}  ${sem.quality.toFixed(3)}    ${opt.score.quality.toFixed(3)}     +${(opt.score.quality - tidy.quality).toFixed(3)}`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
  }, 60000);

  // THE TRACEABILITY GATE (R4, owner verdict). The owner field-tested the ideal layout and ruled it WORSE
  // than Tidy — it "packs tighter AND overlaps lines more," against his aesthetic of separate, traceable corridors.
  // This asserts the fix on the MEASURE he judged by: total line-on-line OVERLAP (px, on the real routed wires).
  // The optimizer must never overlap lines MORE than Tidy — "SDA ≥ Tidy on traceability" — on any committed design.
  // This runs in CI (no dagre/ELK), so the regression that produced his verdict can never re-land silently.
  it('the optimizer never overlaps wires more than Tidy — the owner traceability requirement', () => {
    const lines: string[] = ['\nline-on-line OVERLAP length (px, lower = more traceable):'];
    lines.push('design                                 tidy   optimize');
    for (const f of EXAMPLES) {
      const d = load(f);
      const tidyOverlap = separationMetrics(layoutGeometry(d, tidyOf(d))).overlapLen;
      const opt = optimizeLayout(d, { seed: 1, budgetMs: 3000, sizes: sizesFor(d) });
      const optOverlap = separationMetrics(layoutGeometry(d, opt.placement)).overlapLen;
      expect(optOverlap, `${f}: optimizer overlap (${optOverlap.toFixed(0)}px) ≤ Tidy overlap (${tidyOverlap.toFixed(0)}px)`).toBeLessThanOrEqual(tidyOverlap + 1e-6);
      lines.push(`${f.replace('.sda.json', '').padEnd(38)} ${tidyOverlap.toFixed(0).padStart(6)}  ${optOverlap.toFixed(0).padStart(8)}`);
    }
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
  }, 60000);

  // THE FAST-PATH FIRE RATE (R5, port-centric alignment — the owner nuance). Rows used to align node geometry
  // while wires anchor at PORT fractions, so "aligned" rows still routed as Zs and the router's straight-line
  // fast path (ports within its 4px snap) rarely fired. This measures the cascade on the wires that ship: how
  // many routed wires are ONE straight segment. The SEMANTIC stage is a pure function (no wall clock), so it is
  // pinned twice: per-example absolute floors at the R5 measurement, and the LAW that the deterministic pass
  // never draws fewer straight wires than Tidy. Measured straight wires per design (R4 baseline → R5):
  //   semantic: cqrs 6 → 7 · ecommerce-production 1 → 3 · cqrs-production-large 9 → 13 · oracle-to-aurora 0 → 3
  //   optimize (seed 1, full budget): cqrs 5 → 5 · ecommerce 1 → 2 · large 11 → 11 · oracle 2 → 2 — while the
  //   winner's QUALITY rose (cqrs 0.883, large 0.785): straights are a tie-break under the ratified vector, so on
  //   CQRS it keeps the mirrored fan-outs over Tidy's accidental seventh straight (see layout-optimize result()).
  it('the straight-line fast path fires: the semantic pass never draws fewer straight wires than Tidy, and holds the R5 floors', () => {
    const floors: Record<string, number> = {
      'cqrs.sda.json': 7,
      'ecommerce-production.sda.json': 3,
      'cqrs-production-large.sda.json': 13,
      'oracle-to-aurora-migration-repeat.sda.json': 3,
    };
    const lines: string[] = ['\nstraight routed wires (the fast path made real):'];
    lines.push('design                                 tidy   semantic  optimize   (of total)');
    for (const f of EXAMPLES) {
      const d = load(f);
      const tidy = straightWireCount(layoutGeometry(d, tidyOf(d)));
      const sem = straightWireCount(layoutGeometry(d, semanticLayout(d, sizesFor(d))));
      const opt = straightWireCount(layoutGeometry(d, optimizeLayout(d, { seed: 1, budgetMs: 3000, sizes: sizesFor(d) }).placement));
      lines.push(`${f.replace('.sda.json', '').padEnd(38)} ${String(tidy).padStart(4)} ${String(sem).padStart(9)} ${String(opt).padStart(9)}   /${d.wires.length}`);
      expect(sem, `${f}: semantic straight wires ≥ tidy straight wires`).toBeGreaterThanOrEqual(tidy);
      expect(sem, `${f}: semantic straight wires ≥ the R5 measured floor`).toBeGreaterThanOrEqual(floors[f]!);
    }
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
  }, 60000);

  // THE BEND-JUSTIFICATION LAW (R6, the owner's "needlessly broken lines" verdict at HEAD 1b07f93). EVERY BEND
  // MUST BE JUSTIFIED — by obstacle clearance (the canonical shape is blocked) or by shared-corridor separation
  // (the wire holds a distinct track). The router enforces it (edge-routing `justifyBends`, the final routing
  // stage) and THIS gate audits the enforcement end-to-end: on every committed example, at every shipping stage's
  // placement, ZERO wires bend more than their clear, corridor-free canonical straight/Z/L. Runs in CI, so a
  // regression in ANY stage — placement, separation, or a future re-shape — that leaves a needless bend can never
  // land silently.
  it('every bend is justified — zero needless bends on every committed example (the LAW gate)', () => {
    const lines: string[] = ['\nneedless bends (canonical clear + corridor-free at final geometry, yet the route bends more):'];
    lines.push('design                                 tidy   semantic  optimize');
    for (const f of EXAMPLES) {
      const d = load(f);
      const sizes = sizesFor(d);
      const stages: Record<string, Placement> = {
        tidy: tidyOf(d),
        semantic: semanticLayout(d, sizes),
        optimize: optimizeLayout(d, { seed: 1, budgetMs: 3000, sizes }).placement,
      };
      const counts: Record<string, number> = {};
      for (const [stage, p] of Object.entries(stages)) {
        const audit = auditDesignEdges({ nodes: nodeGeoms(d, p), wires: d.wires.map((w) => ({ from: w.from, to: w.to })), groups: groupRects(d, p) });
        counts[stage] = audit.length;
        expect(audit, `${f} @ ${stage}: a clear, corridor-free canonical must ship — needless bends`).toEqual([]);
      }
      lines.push(`${f.replace('.sda.json', '').padEnd(38)} ${String(counts.tidy).padStart(4)} ${String(counts.semantic).padStart(9)} ${String(counts.optimize).padStart(9)}`);
    }
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
  }, 60000);

  // THE OWNER'S NAMED CASE (R6): "cli_cmd → waf in examples/cqrs-production-large.sda.json bends without reason."
  // Diagnosis, reproduced on the live canvas at HEAD 1b07f93: the committed layout aligns node TOPS (y=58 across
  // the write chain — it was authored at uniform node sizes and rounded), but a wire anchors at portFraction × the
  // MEASURED height, and the canvas measures cli_cmd at 126px vs waf at 151px — so the two port anchors sit
  // (151−126)/2 = 12.5px apart, outside the router's ratified 4px snap, and the wire lawfully ships the canonical
  // symmetric Z (a hair-thin jog). Separation and the search are innocent: the shape IS the canonical. This pin
  // holds both halves of the verdict, at the exact rendered geometry (the committed layout + the heights the
  // canvas measured, captured live):
  //   • the committed file never degrades below canonical — cli_cmd→waf is STRAIGHT or the SYMMETRIC Z, and the
  //     whole design audits zero needless bends;
  //   • given the measured geometry, the shipping pipeline aligns the ANCHORS (not the tops), so the wire ships as
  //     ONE straight segment — what the ✨ Ideal button produces on the live canvas.
  // THE PORT SLIDE GATE (R5, port-position assignment). A port may slide along its node edge to sit exactly
  // opposite its peer (layout-ports `acceptedPortOffsets` — ELK port-position / yFiles port-optimization class).
  // Measured on every committed example, at the geometry that SHIPS (the router anchored at the assigned offsets):
  //   • NEVER WORSE, BY LAW: at every stage the slide draws ≥ as many one-segment straight wires as the fractions
  //     (the acceptance guarantees it; this gate proves the guarantee end-to-end);
  //   • THE R5 FLOORS, pinned on the PURE stages (tidy / semantic + slide — no wall clock, exactly reproducible):
  //     tidy+slide  cqrs 7→9 · ecommerce 1→1 (slide honestly REJECTED: it would trade the R4 traceability floor
  //     for a straight — fractions ship) · cqrs-production-large 12→13 · oracle 2→4;
  //   • the standing laws hold WITH the slide: line-on-line overlap ≤ Tidy's (the R4 owner verdict), ZERO needless
  //     bends (the R6 LAW audits the offset anchors), and every assigned side keeps ≥ MIN_PORT_GAP between handles
  //     (the port-level readability floor).
  it('the port slide cashes as straight wires — never fewer than fractions, R5 floors held, gap/overlap/bend laws intact', () => {
    const floors: Record<string, number> = {
      'cqrs.sda.json': 9,
      'ecommerce-production.sda.json': 1,
      'cqrs-production-large.sda.json': 13,
      'oracle-to-aurora-migration-repeat.sda.json': 4,
    };
    const lines: string[] = ['\nstraight routed wires, fractions → slide (the R5 port-position assignment):'];
    lines.push('design                                 stage      frac  slide   (of total)');
    for (const f of EXAMPLES) {
      const d = load(f);
      const sizes = sizesFor(d);
      const tidy = tidyOf(d);
      const tidyOverlap = separationMetrics(layoutGeometry(d, tidy)).overlapLen;
      const opt = optimizeLayout(d, { seed: 1, budgetMs: 3000, sizes });
      const stages: Record<string, { p: Placement; offsets: ReturnType<typeof acceptedPortOffsets> }> = {
        tidy: { p: tidy, offsets: acceptedPortOffsets(d, tidy, sizes) },
        semantic: { p: semanticLayout(d, sizes), offsets: acceptedPortOffsets(d, semanticLayout(d, sizes), sizes) },
        optimize: { p: opt.placement, offsets: opt.portOffsets },
      };
      for (const [stage, { p, offsets }] of Object.entries(stages)) {
        const frac = straightWireCount(layoutGeometry(d, p));
        const slid = straightWireCount(layoutGeometry(d, p, undefined, offsets));
        lines.push(`${f.replace('.sda.json', '').padEnd(38)} ${stage.padEnd(9)} ${String(frac).padStart(4)} ${String(slid).padStart(6)}   /${d.wires.length}`);
        expect(slid, `${f} @ ${stage}: slide straights ≥ fraction straights (the acceptance law)`).toBeGreaterThanOrEqual(frac);
        if (Object.keys(offsets).length > 0) {
          // the port-level readability floor: assigned handles never packed tighter than the minimum gap
          expect(minAssignedPortGap(d, offsets), `${f} @ ${stage}: assigned port gap ≥ ${MIN_PORT_GAP}`).toBeGreaterThanOrEqual(MIN_PORT_GAP - 1e-9);
          // the R4 traceability law at the geometry that ships: the slide never buys a straight with overlap —
          // it stays within the stage's own fraction overlap or Tidy's, whichever the acceptance floored it at
          // (the SHIPPING stage, optimize, is floored at Tidy — the standing owner gate — asserted below).
          const slideOverlap = separationMetrics(layoutGeometry(d, p, undefined, offsets)).overlapLen;
          const fracOverlap = separationMetrics(layoutGeometry(d, p)).overlapLen;
          expect(slideOverlap, `${f} @ ${stage}: slide overlap within the acceptance floor`).toBeLessThanOrEqual(Math.max(fracOverlap, tidyOverlap) + 1e-6);
          if (stage === 'optimize') expect(slideOverlap, `${f} @ optimize: SHIPPED slide overlap ≤ Tidy overlap (the R4 owner gate)`).toBeLessThanOrEqual(tidyOverlap + 1e-6);
          // the R6 bend LAW audits clean at the assigned anchors too
          const audit = auditDesignEdges({ nodes: nodeGeoms(d, p, undefined, offsets), wires: d.wires.map((w) => ({ from: w.from, to: w.to })), groups: groupRects(d, p) });
          expect(audit, `${f} @ ${stage}: zero needless bends at assigned offsets`).toEqual([]);
        }
      }
      const tidySlid = straightWireCount(layoutGeometry(d, tidy, undefined, stages.tidy!.offsets));
      expect(tidySlid, `${f}: tidy+slide straight wires ≥ the R5 measured floor`).toBeGreaterThanOrEqual(floors[f]!);
    }
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
  }, 60000);

  const MEASURED_H: Readonly<Record<string, number>> = {
    cli_cmd: 126, cli_qry: 126, waf: 151, alb_w: 151, apigw: 151, cmd: 166, rds: 151, aurora: 166,
    kafka: 151, saga: 166, proj_read: 166, proj_srch: 151, proj_hot: 151, rstore: 166, es: 138,
    redis: 151, dlq: 151, notifier: 166, analytics: 166, s3_an: 166, cdn: 151, alb_r: 151, query: 151,
  };
  /** Straight, or the canonical symmetric Z (both bends on the midpoint x of the two anchors) — the owner's
   *  accepted shapes for the named wire. Anything else (a stub-jogged Z, an A* staircase) fails. */
  const straightOrSymmetricZ = (pts: readonly Pos[]): boolean => {
    if (pts.length === 2) return pts[0]!.y === pts[1]!.y || pts[0]!.x === pts[1]!.x;
    if (pts.length !== 4) return false;
    const midX = (pts[0]!.x + pts[3]!.x) / 2;
    return pts[1]!.x === midX && pts[2]!.x === midX;
  };
  it('the owner case — cli_cmd→waf: straight-or-canonical-Z on the committed file, ONE straight segment once the pipeline sees the measured geometry', () => {
    const raw = readRaw('cqrs-production-large.sda.json');
    const sizes: Record<string, { w: number; h: number }> = {};
    for (const i of raw.instances) sizes[i.id] = { w: 160, h: MEASURED_H[i.id]! };
    const d: LayoutDesign = {
      nodes: raw.instances.map((i) => ({ id: i.id, type: i.type, size: sizes[i.id]! })),
      wires: raw.wires.map((w) => (w.semantics !== undefined ? { from: w.from, to: w.to, semantics: w.semantics } : { from: w.from, to: w.to })),
      groups: (raw.groups ?? []).map((g) => ({ id: g.id, members: g.members })),
    };
    const wireIdx = raw.wires.findIndex((w) => w.from[0] === 'cli_cmd' && w.to[0] === 'waf');
    expect(wireIdx).toBeGreaterThanOrEqual(0);
    const wires = d.wires.map((w) => ({ from: w.from, to: w.to }));
    const routeAt = (p: Placement): readonly Pos[] => routeDesignEdges({ nodes: nodeGeoms(d, p), wires, groups: groupRects(d, p) }).get(wireIdx)!.points;

    // (1) The committed geometry (stored layout + measured heights) — his screen: never worse than canonical.
    const stored = raw.layout!;
    const committedPts = routeAt(stored);
    expect(straightOrSymmetricZ(committedPts), `committed route must be straight or the symmetric Z: ${JSON.stringify(committedPts)}`).toBe(true);
    expect(auditDesignEdges({ nodes: nodeGeoms(d, stored), wires, groups: groupRects(d, stored) }), 'committed file: zero needless bends').toEqual([]);

    // (2) The pipeline at the measured geometry: the semantic pass aligns the port ANCHORS ⇒ one straight segment.
    const semPts = routeAt(semanticLayout(d, sizes));
    expect(semPts.length, `semantic@measured must draw cli_cmd→waf as ONE segment: ${JSON.stringify(semPts)}`).toBe(2);
    expect(semPts[0]!.y).toBe(semPts[1]!.y);

    // (3) The full optimizer at the measured geometry stays within the owner's accepted shapes.
    const optPts = routeAt(optimizeLayout(d, { seed: 1, budgetMs: 3000, sizes }).placement);
    expect(straightOrSymmetricZ(optPts), `optimized route must be straight or the symmetric Z: ${JSON.stringify(optPts)}`).toBe(true);
  }, 60000);
});

// ── The four-way comparison vs dagre / ELK + SVG previews (gated) ────────────────────────────────────────────────
const BENCH = process.env.RUN_LAYOUT_BENCH === '1';

/** dagre → a top-left Placement (dagre reports node CENTRES). Loaded dynamically via a non-literal specifier so the
 *  untyped CJS module never enters the strict typecheck. */
async function dagreLayout(d: LayoutDesign): Promise<Placement> {
  const spec = 'dagre';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dagre: any = (await import(spec)).default;
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 80, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of d.nodes) g.setNode(n.id, { width: SIZE.w, height: SIZE.h });
  for (const w of d.wires) if (w.from[0] !== w.to[0]) g.setEdge(w.from[0], w.to[0]);
  dagre.layout(g);
  const out: Record<string, { x: number; y: number }> = {};
  for (const n of d.nodes) {
    const node = g.node(n.id);
    if (node) out[n.id] = { x: node.x - SIZE.w / 2, y: node.y - SIZE.h / 2 };
  }
  return out;
}

/** elkjs (layered) → a top-left Placement (ELK reports top-left). */
async function elkLayout(d: LayoutDesign): Promise<Placement> {
  const spec = 'elkjs/lib/elk.bundled.js';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ELK: any = (await import(spec)).default;
  const elk = new ELK();
  const graph = {
    id: 'root',
    layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.spacing.nodeNode': '40', 'elk.layered.spacing.nodeNodeBetweenLayers': '120' },
    children: d.nodes.map((n) => ({ id: n.id, width: SIZE.w, height: SIZE.h })),
    edges: d.wires.filter((w) => w.from[0] !== w.to[0]).map((w, i) => ({ id: `e${i}`, sources: [w.from[0]], targets: [w.to[0]] })),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = await elk.layout(graph);
  const out: Record<string, { x: number; y: number }> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of res.children ?? []) out[c.id] = { x: c.x ?? 0, y: c.y ?? 0 };
  return out;
}

/** A self-contained SVG of a placement + its real routed wires (before/after evidence). */
function renderSvg(d: LayoutDesign, placement: Placement, title: string): string {
  const nodes = nodeGeoms(d, placement);
  const groups = groupRects(d, placement);
  const routed = routeDesignEdges({ nodes, wires: d.wires.map((w) => ({ from: w.from, to: w.to })), groups });
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.box.x);
    minY = Math.min(minY, n.box.y);
    maxX = Math.max(maxX, n.box.x + n.box.w);
    maxY = Math.max(maxY, n.box.y + n.box.h);
  }
  const pad = 40;
  const W = maxX - minX + 2 * pad;
  const H = maxY - minY + 2 * pad;
  const tx = (x: number): number => x - minX + pad;
  const ty = (y: number): number => y - minY + pad;
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(W)}" height="${Math.round(H)}" viewBox="0 0 ${Math.round(W)} ${Math.round(H)}" font-family="Segoe UI,system-ui,sans-serif">`);
  parts.push(`<rect width="100%" height="100%" fill="#fbfaf7"/>`);
  parts.push(`<text x="16" y="26" font-size="15" font-weight="700" fill="#183a56">${title}</text>`);
  for (const g of groups) parts.push(`<rect x="${tx(g.rect.x)}" y="${ty(g.rect.y)}" width="${g.rect.w}" height="${g.rect.h}" rx="10" fill="#eef4fb" stroke="#3b6fd4" stroke-opacity=".35"/>`);
  d.wires.forEach((w, i) => {
    const r = routed.get(i);
    if (r === undefined) return;
    const shifted = r.points.map((p) => ({ x: tx(p.x), y: ty(p.y) }));
    const dash = w.semantics === 'async' ? ' stroke-dasharray="6 4"' : '';
    parts.push(`<path d="${orthogonalPathD(shifted)}" fill="none" stroke="#7a8394" stroke-width="1.5"${dash}/>`);
  });
  for (const n of nodes) {
    parts.push(`<rect x="${tx(n.box.x)}" y="${ty(n.box.y)}" width="${n.box.w}" height="${n.box.h}" rx="8" fill="#fff" stroke="#0b6e6e"/>`);
    parts.push(`<text x="${tx(n.box.x) + n.box.w / 2}" y="${ty(n.box.y) + n.box.h / 2}" font-size="12" text-anchor="middle" fill="#1a1d23">${n.id}</text>`);
  }
  parts.push('</svg>');
  return parts.join('\n');
}

describe.runIf(BENCH)('layout benchmark — four-way vs dagre / ELK (RUN_LAYOUT_BENCH=1)', () => {
  it('scores Tidy / dagre / ELK / SDA on the SAME router + objective and writes previews', async () => {
    const outDir = new URL('../../../scratchpad/ideal-layout/', import.meta.url);
    try {
      mkdirSync(outDir, { recursive: true });
    } catch {
      // best-effort; the table prints regardless
    }
    const semanticTerms = LAYOUT_TERMS.filter((t) => TERM_KIND[t] === 'semantic');
    const semanticAggregate = (s: LayoutScore): number => {
      // weighted sum of the SEMANTIC penalties over the active ones (0 = ideal) — the moat, isolated.
      let w = 0;
      let sum = 0;
      for (const t of semanticTerms) {
        const p = s.penalties[t];
        if (p === null) continue;
        w += LAYOUT_WEIGHTS[t];
        sum += LAYOUT_WEIGHTS[t] * p;
      }
      return w > 0 ? sum / w : 0;
    };
    const report: string[] = [];
    const engines = ['tidy', 'dagre', 'elk', 'sda'] as const;
    const rows: { design: string; scored: Record<string, LayoutScore> }[] = [];
    const rowSep: Record<string, Record<string, ReturnType<typeof separationMetrics>>> = {};

    for (const f of EXAMPLES) {
      const d = load(f);
      const placements: Record<string, Placement> = {
        tidy: tidyOf(d),
        dagre: await dagreLayout(d),
        elk: await elkLayout(d),
        sda: optimizeLayout(d, { seed: 1, budgetMs: 3000, sizes: sizesFor(d) }).placement,
      };
      const scored: Record<string, LayoutScore> = {};
      for (const [k, p] of Object.entries(placements)) scored[k] = scoreLayout(d, p);
      rows.push({ design: f, scored });

      report.push(`\n### ${f}  (${d.nodes.length} nodes, ${d.wires.length} wires, ${d.groups.length} groups)`);
      report.push(['term'.padEnd(10), ...engines.map((e) => e.padStart(7))].join(' '));
      for (const t of LAYOUT_TERMS) {
        report.push([`${t}${TERM_KIND[t] === 'semantic' ? '*' : ''}`.padEnd(10), ...engines.map((e) => fmt(scored[e]!.penalties[t]).padStart(7))].join(' '));
      }
      report.push(['SEMANTIC*'.padEnd(10), ...engines.map((e) => semanticAggregate(scored[e]!).toFixed(3).padStart(7))].join(' '));
      report.push(['QUALITY'.padEnd(10), ...engines.map((e) => scored[e]!.quality.toFixed(3).padStart(7))].join(' '));
      report.push(['feasible'.padEnd(10), ...engines.map((e) => String(scored[e]!.feasible).padStart(7))].join(' '));
      // SEPARATION metrics (px, the owner's traceability yardstick) — measured on the SAME routed wires as the
      // scores: overlapPx = total line-on-line overlap (lower = traceable); minGapPx = tightest parallel-track gap
      // (Inf = no wires share a corridor); mergePx = mean distance from a shared target at which a fan-in converges
      // (lower = later, "near the destination port"). SDA optimises for these; the generic engines do not.
      const sep: Record<string, ReturnType<typeof separationMetrics>> = {};
      for (const e of engines) sep[e] = separationMetrics(layoutGeometry(d, placements[e]!));
      report.push(['overlapPx'.padEnd(10), ...engines.map((e) => sep[e]!.overlapLen.toFixed(0).padStart(7))].join(' '));
      report.push(['minGapPx'.padEnd(10), ...engines.map((e) => (sep[e]!.minGap === Infinity ? 'Inf' : sep[e]!.minGap.toFixed(0)).padStart(7))].join(' '));
      report.push(['mergePx'.padEnd(10), ...engines.map((e) => sep[e]!.meanMergeDist.toFixed(0).padStart(7))].join(' '));
      rowSep[f] = sep;

      for (const [engine, p] of Object.entries(placements)) {
        writeFileSync(new URL(`${f.replace('.sda.json', '')}-${engine}.svg`, outDir), renderSvg(d, p, `${f.replace('.sda.json', '')} — ${engine}`));
      }
    }
    // eslint-disable-next-line no-console
    console.log(report.join('\n') + `\n\n(* = SEMANTIC terms only SDA optimises for; lower penalty = better; previews → scratchpad/ideal-layout/)`);

    // The DEFENSIBLE claims — measured, not felt (the tool must not lie). BEFORE R2 dagre (a strong compaction
    // engine) edged the whole-objective aggregate on the ungrouped DAGs, because SDA kept Tidy's wide 340px columns
    // (long wires, slack area) and could not mirror a fan-out. R2 closed BOTH: rank compaction (node-size-aware X
    // tightening) took the length/area gap, and fan-out symmetrization (Reingold–Tilford downstream-centering) took
    // the symmetry gap — so SDA now beats dagre AND elk on EVERY design where they are a FAIR (feasible) comparison,
    // and the group-awareness win still stands where they are not:
    //   (1) SDA is always hard-constraint FEASIBLE; dagre/ELK, blind to GROUPS, produce infeasible output on the
    //       grouped designs (they pack nodes across group boundaries / overlap under the real router). Comparing a
    //       feasible layout to an infeasible one is meaningless — an illegal layout can score anything — so the
    //       head-to-head aggregate claim is asserted ONLY where the generic engine is itself feasible (2).
    //   (2) On every design where dagre/ELK route FEASIBLY, SDA's whole-objective aggregate is ≥ theirs (the R2 win:
    //       we now match the generic engines on their own generic terms AND keep the semantic moat).
    //   (3) SDA improves the SEMANTIC aggregate over the shipping baseline (Tidy) on every example — the moat.
    //   (4) SDA never underperforms Tidy on the whole objective (the floor).
    for (const { design, scored } of rows) {
      expect(scored.sda!.feasible, `${design}: sda feasible`).toBe(true);
      expect(scored.sda!.quality, `${design}: sda quality ≥ tidy`).toBeGreaterThanOrEqual(scored.tidy!.quality - 1e-9);
      expect(semanticAggregate(scored.sda!), `${design}: sda semantic ≤ tidy semantic`).toBeLessThanOrEqual(semanticAggregate(scored.tidy!) + 1e-9);
      // (R4) TRACEABILITY — SDA overlaps wires ≤ Tidy (the owner's verdict, made a gate): the separation pass +
      // objective must never regress line-on-line overlap below Tidy's on any committed design.
      expect(rowSep[design]!.sda!.overlapLen, `${design}: sda overlap ≤ tidy overlap (traceability)`).toBeLessThanOrEqual(rowSep[design]!.tidy!.overlapLen + 1e-6);
      for (const engine of ['dagre', 'elk'] as const) {
        if (!scored[engine]!.feasible) continue; // an infeasible generic layout is not a fair aggregate comparison
        expect(scored.sda!.quality, `${design}: sda quality ≥ feasible ${engine} (R2 compaction+symmetry win)`).toBeGreaterThanOrEqual(scored[engine]!.quality - 1e-9);
      }
    }
    const dagreFeasibleBeaten = rows.filter((r) => r.scored.dagre!.feasible && r.scored.sda!.quality >= r.scored.dagre!.quality).map((r) => r.design);
    expect(dagreFeasibleBeaten.length, 'SDA beats dagre on the ungrouped DAGs where dagre is a fair comparison').toBeGreaterThan(0);
    const groupedInfeasible = rows.filter((r) => !r.scored.dagre!.feasible || !r.scored.elk!.feasible).map((r) => r.design);
    expect(groupedInfeasible.length, 'dagre/ELK are infeasible on the grouped designs — the group-awareness win').toBeGreaterThan(0);
  }, 120000);
});
