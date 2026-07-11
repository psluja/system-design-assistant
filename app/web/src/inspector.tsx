import { useEffect, useRef, useState, type MouseEvent as RMouseEvent, type RefObject } from 'react';
import type { Studio, ProjectDoc, Group } from '@sda/core';
import type { Key, Verdict } from '@sda/engine-core';
import { registry, keys, protocolNote, type AssumptionScenario, type Manifest, type Range } from '@sda/content';
import {
  keyInfo, fmt, formatMs, opnd, rate, prettyExpr,
  knobGroupOf, isHiddenKnob, KNOB_GROUP_TITLE, SECTION_CAPTIONS, PROMISES_TITLE, resolvePortTransform,
  formatRange, overrideProvenanceLabel, formatResponseTail,
  type Suggestion, type NodeResponseView,
} from '@sda/presenter';
import { NodeId } from '@sda/engine-core';
import { facetsOf } from './facets';
import { iconFor } from './icons';
import { bindBrowserSolvers } from './composition';

// Hidden for the FIRST RELEASE (owner, 2026-07-11): advanced / developer-facing Inspector panels — Ports+transforms,
// Alternatives, the engine "Suggested next" (redundant with the on-canvas "+"), and the model-drift diagnostic.
// The logic stays; only the display is gated. Set to false to bring them back.
const HIDE_ADVANCED = true;

// The SLO dimensions an architect declares PER NODE (owner ruling 2026-07-11: promise on the FEW nodes you care
// about; the engine computes the rest). COST IS DELIBERATELY ABSENT — a cost promise is whole-system (the System
// panel's one home), never per-node. Latency is the mean; p99 is the tail (a separate `percentiles` band).
const NODE_SLO: ReadonlyArray<{ key: Key; cmp: '≥' | '≤'; label: string; unit: string }> = [
  { key: keys.throughput, cmp: '≥', label: 'Throughput', unit: 'rps' },
  { key: keys.latency, cmp: '≤', label: 'Latency', unit: 'ms' },
  { key: keys.tailLatency, cmp: '≤', label: 'p99 (tail)', unit: 'ms' },
  { key: keys.availability, cmp: '≥', label: 'Availability', unit: 'ratio' },
];


// The INSPECTOR (`.insp` aside), extracted from app.tsx — always per-selection scope (whole-design
// lenses live in the System drawer). For a component: identity, the role-axis knob groups (assumptions / limits),
// promises, ports+transforms, the transparent cost model, compare-alternatives, the verdict and the engine's
// suggested-next; for a group: label + members. Pure rendering over App-owned document state — every mutation is
// a Studio command; the panel owns only its OWN compare-run state (`cmp`, keyed by node so a stale run never
// paints another selection). All domain math comes from the engine/content values passed in — the web adds none.

/**
 * A text field that stays UNCONTROLLED while the user types (so partial / decimal entry like "2." is never
 * clobbered mid-edit), but RESYNCS from the model when it changes externally — undo / redo, an Improve "apply",
 * a sizing swap — by writing the new value to the DOM only when the field is NOT focused. Without this the
 * inspector knob keeps the stale typed value after an undo while the model already moved on (BO-3).
 */
function SyncedField({ value, onCommit, className }: { value: string; onCommit: (raw: string) => void; className?: string }): JSX.Element {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el && el.value !== value) el.value = value;
  }, [value]);
  return <input ref={ref} type="text" inputMode="decimal" className={className} defaultValue={value} onChange={(e) => onCommit(e.target.value)} />;
}

/** One compare_options row: an alternative type sized to this node's SLOs (clingo enumerate → in-process size → rank). */
type CmpRow = { type: string; cost: number; overflow: number; availability?: number; throughput?: number; sizing: { key: string; value: number }[] };

/**
 * How THIS node's OWN monthly cost is built — surfaced as a transparent base × driver breakdown, never a
 * bare number. `cost` is either a flat config rate or a relation (base rate × what the component scales with).
 * The driver value shown MUST satisfy driverVal × base = ownVal exactly. The relation reads SELF for a
 * provisioned ceiling (self(throughput)) or a local count (concurrency/requiredUnits) — NOT the path-AGGREGATED
 * engine value (min concurrency upstream, or the incoming flow), which would print a false equation
 * (e.g. "concurrency 350 × $1.4 = $1400"). Deriving it from the true own cost can never lie.
 */
function costModelOf(selInst: { readonly id: string; readonly config?: Readonly<Record<string, number>> }, selMan: Manifest, own: number | undefined):
  | { ownVal: number; flat: true }
  | { ownVal: number; flat: false; formula: string; driver: string | undefined; driverVal: number | undefined; base: number | undefined }
  | undefined {
  const rel = (selMan.relations ?? []).find((r) => String(r.key) === 'cost');
  const flat = (selMan.config ?? []).find((c) => String(c.key) === 'cost');
  if (own === undefined && rel === undefined && flat === undefined) return undefined; // cost not modelled here
  const ownVal = own ?? (flat ? Number(selInst.config?.['cost'] ?? flat.value) : 0);
  if (rel === undefined) return { ownVal, flat: true as const };
  const driver = (rel.reads ?? []).map(String).find((key) => key !== 'unitCost');
  const baseCfg = (selMan.config ?? []).find((c) => String(c.key) === 'unitCost');
  const base = baseCfg ? Number(selInst.config?.['unitCost'] ?? baseCfg.value) : undefined;
  const driverVal = driver !== undefined && base !== undefined && base > 0 ? ownVal / base : undefined;
  return { ownVal, flat: false as const, formula: prettyExpr(rel.expr), driver, driverVal, base };
}

/** The Inspector aside. `selInst`/`selMan`/`selGroup` are App-derived from `sel` (App also drives shortcuts and
 *  the context menu off them — one derivation, passed down). */
export function InspectorPanel({
  studio, doc, sel, onSelect, selInst, selMan, selGroup,
  verds, simResponses, respByNode, localCost, valueOf,
  activeWorld, active, onCommitConfig,
  suggestions, onAddSuggestion,
  isCustom, onEditType, labelOf, descOf,
  onEditTransform, onEditRange, onError, nameRef,
}: {
  studio: Studio;
  doc: ProjectDoc;
  sel: string | null;
  onSelect: (id: string | null) => void;
  selInst: ProjectDoc['instances'][number] | undefined;
  selMan: Manifest | undefined;
  selGroup: Group | undefined;
  verds: readonly Verdict[];
  /** The DES run's per-node response tails (null before a sim measured anything). */
  simResponses: readonly NodeResponseView[] | null;
  respByNode: ReadonlyMap<string, number>;
  localCost: Readonly<Record<string, number>>;
  /** The engine's computed value for any (node, key) — the live "now" a per-node promise is judged against
   *  (throughput / availability read this; latency / p99 read the node's own MEASURED response instead). */
  valueOf: (id: string, k: Key) => number | undefined;
  activeWorld: AssumptionScenario | undefined;
  active: string | undefined;
  onCommitConfig: (node: string, key: string, value: number) => void;
  suggestions: readonly Suggestion[];
  onAddSuggestion: (s: Suggestion, type: string) => void;
  isCustom: (t: string) => boolean;
  onEditType: (t: string) => void;
  labelOf: (id: string, type: string) => string;
  descOf: (id: string) => string;
  onEditTransform: (node: string, port: string, anchor: { x: number; y: number }) => void;
  onEditRange: (node: string, key: string, label: string, unit: string, point: number, current: Range | null, anchor: { x: number; y: number }) => void;
  onError: (msg: string) => void;
  nameRef: RefObject<HTMLInputElement>;
}): JSX.Element {
  // Reset the inspector to the top whenever a different node is selected — else it opens mid-scroll (on Base cost /
  // Drain rate) after a prior Compare/scroll, hiding the node header, the Verdict and the Suggested-next actions.
  const inspRef = useRef<HTMLElement>(null);
  // Which promise dimensions the user has REVEALED via "+ Add promise" on this node (beyond the ones already
  // declared as bands). Reset on selection change so a revealed-but-unfilled row never leaks to the next node.
  const [addSlo, setAddSlo] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => { inspRef.current?.scrollTo({ top: 0 }); setAddSlo(new Set()); }, [sel]);

  // compare_options results for the selected node (clingo enumerate → in-process size → rank), keyed by node id
  const [cmp, setCmp] = useState<{ node: string; loading?: boolean; rows?: CmpRow[]; error?: string } | null>(null);
  // Compare alternatives for the selected node: clingo enumerates every type that fits its wiring, the engine
  // sizes each to meet its SLOs, ranked by cost. Reuses the exact `compare_options` tool the AI/bridge uses.
  const onCompare = async (): Promise<void> => {
    if (!selInst) return;
    const node = selInst.id;
    setCmp({ node, loading: true });
    try {
      // Same composition root as Improve + the AI bridge: the native in-process adapter for Optimize plus the
      // lazily-imported clingo provider for Enumerate, so compare_options draws the SAME SolverBindings the search
      // tools use — one seam, switched in composition.ts (native default; MiniZinc rollback), never two that could drift.
      const solvers = await bindBrowserSolvers(registry);
      const { buildSynthTools } = await import('@sda/mcp/synthesize');
      const tool = buildSynthTools(studio, solvers).find((t) => t.name === 'compare_options');
      if (!tool) { setCmp({ node, error: 'compare_options unavailable' }); return; }
      const res = await tool.run({ node });
      if (sel !== node) return; // selection moved on while the cold solvers ran
      setCmp(res.ok ? { node, rows: JSON.parse(res.text) as CmpRow[] } : { node, error: res.text.replace(/^error:\s*/, '') });
    } catch (e) {
      setCmp({ node, error: `Compare needs cross-origin isolation (COOP/COEP): ${String(e)}` });
    }
  };
  const applyOption = (r: CmpRow): void => {
    if (!selInst) return;
    // ONE undoable action: swapping the type + its sizing is a single user choice, so a single Undo restores the
    // prior design (not a hybrid: new type, old/partial sizing). setType keeps id/wires/SLOs and resets capacity.
    studio.dispatchBatch([
      { kind: 'setType', id: selInst.id, type: r.type },
      ...r.sizing.map((sz) => ({ kind: 'setConfig' as const, node: selInst.id, key: sz.key, value: sz.value })),
    ]);
    setCmp(null);
  };

  const selVerdicts = sel ? verds.filter((v) => v.scope === NodeId(sel)) : [];
  const selFix = selVerdicts.flatMap((v) => v.remediations)[0]?.action;
  const selCost = selInst && selMan ? costModelOf(selInst, selMan, localCost[selInst.id]) : undefined;

  return (
    <aside className="insp" ref={inspRef}>
      <div className="insp-h">{selGroup ? 'Group' : 'Inspector'}<span className="insp-scope">selected</span></div>
      {selInst && selMan && (
        <>
          <div className="ih">
            <span className="ic">{iconFor(facetsOf(selInst.type).kind)}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <input
                ref={nameRef}
                className="rename"
                key={`${selInst.id}:${doc.labels[selInst.id] ?? ''}`}
                defaultValue={labelOf(selInst.id, selInst.type)}
                title="Friendly name (the id stays the unique identifier)"
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                onBlur={(e) => studio.dispatch({ kind: 'setLabel', id: selInst.id, label: e.target.value })}
              />
              <input
                className="descedit"
                key={`${selInst.id}:desc:${descOf(selInst.id)}`}
                defaultValue={descOf(selInst.id)}
                placeholder="Add a description…"
                title="A one-line description of what this component is for in the design"
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                onBlur={(e) => studio.dispatch({ kind: 'setDescription', id: selInst.id, description: e.target.value })}
              />
              <span>{selInst.id} · {selInst.type}
                <button className="type-edit"
                  title={isCustom(selInst.type) ? 'Edit this component type' : 'Customize this type — saves a project copy that overrides the built-in'}
                  onClick={() => onEditType(selInst.type)}>✎ Edit type</button>
              </span>
            </div>
          </div>
          {/* The registry ROLE AXIS (doc: assumption-model §2, shared presenter `knobGroupOf`) replaces the flat
              "Configuration" list: a node's input knobs group into ASSUMPTIONS (facts about your world — a belief
              the design rests on) and RESOURCE LIMITS (a ceiling/sizing the design commits to). Computed values
              stay in the Verdict/Cost readouts; promises (SLO bands) get their own section below. One form with
              the VS Code native Inspector (same headings/order). */}
          {(() => {
            const cfgs = selMan.config ?? [];
            // Render ONE knob field: the queueMode toggle, or a numeric field with the world-override badge + the
            // ± uncertainty-range affordance.
            const renderKnob = (c: (typeof cfgs)[number]): JSX.Element => {
              const ck = String(c.key);
              // With a world ACTIVE, the field shows THAT world's value for an overridden fact-assumption (a
              // derived/frozen value), badged by provenance — so a derived value reads distinctly from a base one
              // (doc §5.3). The edit routes back into the active world via `onCommitConfig`.
              const activeOv = activeWorld?.overrides.find((o) => o.node === selInst.id && o.key === ck);
              const cur = activeOv?.value ?? selInst.config?.[c.key] ?? c.value;
              if (ck === 'queueMode') {
                return (
                  <div className="field" key={`${selInst.id}:${ck}`}>
                    <label data-tip={keyInfo('queueMode').desc}>Act as queue</label>
                    <input type="checkbox" checked={Number(cur) === 1} onChange={(e) => studio.dispatch({ kind: 'setConfig', node: selInst.id, key: ck, value: e.target.checked ? 1 : 0 })} />
                  </div>
                );
              }
              // A knob's declared uncertainty RANGE (doc: uncertainty-monte-carlo §4) rides on `instance.ranges`,
              // keyed by config key. The ± affordance is COLLAPSED by default (a bare "±"); once a range is set the
              // button shows the compact ±(lo–hi) indicator beside the point value — together they read `130 ±(100–180)`.
              const range = selInst.ranges?.[ck] ?? null;
              return (
                <div className="field" key={`${selInst.id}:${ck}`}>
                  <label data-tip={keyInfo(ck).cfg ?? keyInfo(ck).desc}>{keyInfo(ck).label}{activeOv && <span className="tagmode" style={{ marginLeft: 6 }} title={overrideProvenanceLabel(activeOv.provenance)}>{activeOv.provenance ?? 'manual'}</span>}</label>
                  <div className="slo-row">
                    <SyncedField value={String(cur)} onCommit={(raw) => { const n = Number(raw); if (raw.trim() !== '' && !Number.isNaN(n)) onCommitConfig(selInst.id, ck, n); }} />
                    {/* Always reserve the unit gutter (empty when the knob is unitless) so EVERY input ends at the same right edge. */}
                    <span className="unit-suffix">{keyInfo(ck).unit}</span>
                    {/* CLEAR a world override (doc §5.3): on a FROZEN (architect) value it UN-FREEZES back to derived
                        tracking (the value re-derives from the envelope); on a hand-authored/derived one it removes
                        the override (back to base). Shown only when this knob is overridden in the active world. */}
                    {activeOv && (
                      <button type="button" className="knob-range-btn" title={activeOv.provenance === 'architect' ? 'Return this value to derived tracking (re-derives from the envelope)' : 'Remove this world override (back to the base value)'}
                        onClick={() => studio.dispatch({ kind: 'clearScenarioOverride', scenario: active as string, node: selInst.id, key: ck })}>↺</button>
                    )}
                    {/* The ± range affordance — opens the RangeEditor popover; the label is the collapsed indicator when set. */}
                    <button type="button" className={'knob-range-btn' + (range ? ' has-range' : '')}
                      title={range ? `Uncertainty range ${formatRange(range)} — click to edit or clear` : 'Add an uncertainty ± range (a soft input like 1,500–3,000) — sampled by the Monte-Carlo run'}
                      onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); onEditRange(selInst.id, ck, keyInfo(ck).label, keyInfo(ck).unit, Number(cur), range, { x: Math.max(12, r.left - 250), y: r.bottom + 4 }); }}>
                      {range ? formatRange(range) : '±'}
                    </button>
                  </div>
                </div>
              );
            };
            // The response-composition knob is a DESIGN choice (latencyComposition role = resource-limit) ⇒ it
            // sits in Resource limits. Shown only for a node making ≥2 synchronous downstream calls.
            const showComposition = doc.wires.filter((w) => w.from[0] === selInst.id && (w.semantics ?? 'sync') !== 'async').length >= 2;
            const compositionField = (
              <div className="field" key={`${selInst.id}:latencyComposition`}>
                <label data-tip="How this component combines the RESPONSE latencies of what it calls SYNCHRONOUSLY: sequential (one after another ⇒ they add up), parallel (fan-out, awaited together ⇒ the slowest wins), or fastest (race/hedged ⇒ the quickest wins). Async calls never count. Drives the response time.">Downstream calls</label>
                <select className="comp-select" value={String(selInst.config?.[keys.latencyComposition] ?? 0)} onChange={(e) => studio.dispatch({ kind: 'setConfig', node: selInst.id, key: 'latencyComposition', value: Number(e.target.value) })}>
                  <option value="0">Sequential — add up</option>
                  <option value="1">Parallel — slowest wins</option>
                  <option value="2">Fastest — race</option>
                </select>
              </div>
            );
            const GROUP_TIP: Record<'assumptions' | 'limits', string> = {
              assumptions: 'Facts about the outside world your design rests on — offered load, service-time estimates, a caller’s retry policy. A different world changes these; the engine computes whether the system still holds.',
              limits: 'Ceilings and sizing THIS design commits to — concurrency, replicas, quotas, deployment mode. Changing one is a different design, not a different world; capacity is derived from them.',
            };
            return (['assumptions', 'limits'] as const).map((gid) => {
              // HIDDEN knobs (e.g. `assumedRps`) are suppressed from the rendered list — the shared `isHiddenKnob`
              // (presenter) is the ONE decision both shells consult, so an 'Assumed traffic' row never surfaces here.
              const knobs = cfgs.filter((c) => !isHiddenKnob(String(c.key)) && knobGroupOf(String(c.key)) === gid);
              const withComp = gid === 'limits' && showComposition;
              if (knobs.length === 0 && !withComp) return null; // no-filler: an empty group is not shown
              return (
                <div className="sec" key={gid}><h6 data-tip={GROUP_TIP[gid]}>{KNOB_GROUP_TITLE[gid]}</h6>
                  <p className="insp-cap">{SECTION_CAPTIONS[gid]}</p>
                  {knobs.map(renderKnob)}
                  {withComp && compositionField}
                </div>
              );
            });
          })()}
          {/* PROMISES (the node's SLO bands) — EDITABLE per node (owner ruling 2026-07-11: you promise on the FEW
              nodes you care about; the engine computes the rest; only COST is whole-system, in the System panel).
              Add-on-demand: a declared dimension shows its target beside the live measured value ("now X ✓/✗"); the
              "+ Add promise" picker offers the rest. Latency reads the node's MEASURED mean, p99 its measured tail
              (single-truth latency); throughput/availability read the computed cell. Same field form as the System
              cost promise — one grammar. */}
          {(() => {
            const bands = selInst.bands ?? [];
            const declared = (k: Key): boolean => bands.some((b) => String(b.key) === String(k));
            const shown = NODE_SLO.filter((s) => declared(s.key) || addSlo.has(String(s.key)));
            const remaining = NODE_SLO.filter((s) => !declared(s.key) && !addSlo.has(String(s.key)));
            const nodeResp = simResponses?.find((r) => r.id === selInst!.id) ?? null;
            const dropAdded = (k: Key): void => setAddSlo((prev) => { const next = new Set(prev); next.delete(String(k)); return next; });
            return (
              <div className="sec"><h6 data-tip="The SLO targets (promises) THIS node must keep — set only on the components you care about; the engine computes and checks the rest. Latency/p99 read the node's own measured response; throughput/availability read its computed cell. Whole-system cost is a promise in the System panel.">{PROMISES_TITLE}</h6>
                <p className="insp-cap">{SECTION_CAPTIONS.promises}</p>
                {shown.map(({ key, cmp, label, unit }) => {
                  const isTail = key === keys.tailLatency;
                  const isLat = key === keys.latency;
                  const isRatio = key === keys.availability;
                  const band = bands.find((b) => String(b.key) === String(key))?.band;
                  const cur = isTail
                    ? (band?.shape === 'percentiles' ? band.targets.get('p99') : undefined)
                    : (band?.shape === 'minTargetMax' ? (cmp === '≥' ? band.min : band.max) : undefined);
                  const now = isTail ? nodeResp?.p99 : isLat ? nodeResp?.mean : valueOf(selInst!.id, key);
                  const meets = cur === undefined || now === undefined ? undefined : cmp === '≥' ? now >= cur : now <= cur;
                  return (
                    <div className="field" key={`slo-${String(key)}`}>
                      <label data-tip={keyInfo(String(key)).desc}>{label} <span style={{ color: 'var(--ink3)' }}>{cmp}</span></label>
                      <div className="slo-input">
                        <div className="slo-row">
                          <input type="text" inputMode="decimal" placeholder="—"
                            key={`${selInst!.id}:${String(key)}:${cur ?? ''}`}
                            defaultValue={cur ?? ''}
                            data-tip={`${label} promise ${cmp} on “${labelOf(selInst!.id, selInst!.type)}” (in ${unit || 'ratio'}). The engine checks it on every change and flags a miss. Leave blank to clear.`}
                            onBlur={(e) => {
                              const raw = e.target.value.trim();
                              if (raw === '') { studio.dispatch({ kind: 'clearSLO', node: selInst!.id, key }); dropAdded(key); return; }
                              const n = Number(raw);
                              if (Number.isNaN(n)) return;
                              studio.dispatch(isTail
                                ? { kind: 'setSLO', node: selInst!.id, key, band: { shape: 'percentiles' as const, targets: new Map([['p99', n]]) } }
                                : { kind: 'setSLO', node: selInst!.id, key, band: { shape: 'minTargetMax' as const, ...(cmp === '≥' ? { min: n } : { max: n }) } });
                            }} />
                          <span className="unit-suffix">{unit}</span>
                          <button className="slo-clear" title="Remove this promise" onClick={() => { studio.dispatch({ kind: 'clearSLO', node: selInst!.id, key }); dropAdded(key); }}>×</button>
                        </div>
                        {now !== undefined
                          ? <span className={'slo-now' + (meets === undefined ? '' : meets ? ' ok' : ' bad')}>now {isRatio ? `${(now * 100).toFixed(now >= 0.9999 ? 4 : 2)}%` : (isLat || isTail) ? formatMs(now) : `${fmt(now)} ${unit}`}{meets === undefined ? '' : meets ? ' ✓' : ' ✗'}</span>
                          : (isLat || isTail) ? <span className="slo-now">measuring…</span> : null}
                      </div>
                    </div>
                  );
                })}
                {remaining.length > 0 && (
                  <div className="field">
                    <label data-tip="Add a promise (SLO) this component must keep — the engine checks it on every change. Only the nodes you care about need one.">+ Add promise</label>
                    <div className="slo-input">
                      <select value="" data-tip="Pick a dimension to promise on this node."
                        onChange={(e) => { const k = e.target.value; if (k) setAddSlo((prev) => new Set(prev).add(k)); }}>
                        <option value="" disabled>add a promise…</option>
                        {remaining.map((s) => <option key={String(s.key)} value={String(s.key)}>{s.label} {s.cmp}</option>)}
                      </select>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
          {/* PORTS (R2, doc: flow-transformations-r2 §4) — every port's direction, protocols and active TRANSFORM,
              editable in two clicks. An override (instance transform, or a manifest default) is marked; the row
              opens the same TransformEditor popover the edge pill does. Shown when the manifest declares ports. */}
          {(selMan.ports ?? []).length > 0 && (
            <div className="sec" hidden={HIDE_ADVANCED}><h6 data-tip="Each port's traffic transfer function. A transform on a port scales/collapses/caps the rate crossing it — e.g. a log path emitting ×100. Click to edit; the wire pill shows the resulting rate.">Ports</h6>
              {selMan.ports.map((p) => {
                const inst = selInst;
                const override = inst.transforms?.[p.name] !== undefined;
                const t = resolvePortTransform(inst, selMan, p.name) ?? null;
                const protos = p.dir === 'in' ? (p.accepts ?? []) : p.dir === 'out' ? (p.speaks ?? []) : [...(p.accepts ?? []), ...(p.speaks ?? [])];
                const editAt = (e: RMouseEvent): void => {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  onEditTransform(inst.id, p.name, { x: Math.max(12, r.left - 250), y: r.bottom + 4 });
                };
                return (
                  <div className="port-row" key={`${inst.id}:port:${p.name}`}>
                    <div className="port-row-h">
                      <span className={'port-dir ' + p.dir}>{p.dir}</span>
                      <span className="port-name" title={protos.join(', ')}>{p.name}</span>
                      {protos.length > 0 && <span className="port-protos">{protos.slice(0, 2).join(' · ')}{protos.length > 2 ? ' …' : ''}</span>}
                    </div>
                    <div className="port-row-tf">
                      <button type="button" className={'port-tf-btn' + (t ? ' has-tf' : '')} onClick={editAt} title={t ? `${t.kind}(${t.kind === 'generate' ? t.level : t.value})${override ? ' · overridden' : ' · from catalog'} — click to edit` : 'No transform (identity) — click to add'}>
                        {t ? (
                          <>
                            <span className="port-tf-fn">{t.kind === 'ratio' ? `×${t.value}` : t.kind === 'batch' ? `÷${t.value}` : t.kind === 'cap' ? `cap ${t.value}/s` : t.kind === 'window' ? `window ${t.value}ms` : t.kind === 'generate' ? `⚡${t.level}/s` : `p=${t.value}`}</span>
                            {override && <span className="port-tf-mod" title="Overrides the catalog default (or set on this instance)">modified</span>}
                          </>
                        ) : (
                          <span className="port-tf-none">+ transform</span>
                        )}
                      </button>
                      {t && override && (
                        <button type="button" className="port-tf-clear" title="Clear this port's transform" onClick={() => { const r = studio.dispatch({ kind: 'setTransform', node: inst.id, port: p.name, transform: null }); if (!r.ok) onError(r.error); }}>✕</button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {selCost && (
            <div className="sec"><h6 data-tip="How this component’s OWN monthly cost is built. Every cost SUMS up the path; this is just this node’s share. Edit the Base cost in Configuration to reprice.">Cost</h6>
              <div className="vr"><span className="k">This component</span><span className="v">${fmt(selCost.ownVal)} /mo</span></div>
              {selCost.flat ? (
                <div className="costcalc">flat rate · independent of load</div>
              ) : (
                <div className="costcalc">
                  <code className="cm-formula">{selCost.formula}</code>
                  <div className="cm-sub">
                    {selCost.driver !== undefined && selCost.driverVal !== undefined && <span>{keyInfo(selCost.driver).label.toLowerCase()} <b>{opnd(selCost.driverVal)}</b></span>}
                    {selCost.base !== undefined && <span> × base <b>{rate(selCost.base)}</b></span>}
                    <span> = <b>${opnd(selCost.ownVal)}/mo</b></span>
                  </div>
                </div>
              )}
            </div>
          )}
          <div className="sec" hidden={HIDE_ADVANCED}><h6 data-tip="Run backwards on THIS node: clingo enumerates every component type in the same family that fits its wiring, the engine sizes each to meet its SLOs, and they are ranked by monthly cost. The fair Fargate-vs-Lambda-vs-… compare — pick one to apply it (type + sizing).">Alternatives</h6>
            <button className="btn" disabled={cmp?.node === selInst.id && cmp.loading === true} onClick={() => void onCompare()}>
              {cmp?.node === selInst.id && cmp.loading ? 'Enumerating…' : '⇄ Compare component options'}
            </button>
            {cmp?.node === selInst.id && cmp.error && <p className="muted" style={{ marginTop: 8 }}>{cmp.error}</p>}
            {cmp?.node === selInst.id && cmp.rows && (cmp.rows.length === 0
              ? <p className="muted" style={{ marginTop: 8 }}>No alternative type fits this node’s wiring.</p>
              : (
                <div className="cmp-list">
                  {cmp.rows.map((r) => {
                    const cur = r.type === selInst.type;
                    return (
                      <div className={'cmp-row' + (cur ? ' cur' : '')} key={r.type}>
                        <div className="cmp-head">
                          <span className="cmp-t" title={r.type}>{r.type}{cur ? ' · current' : ''}</span>
                          {!cur && <button className="lnk" onClick={() => applyOption(r)} title="Switch this node to that type and apply its sizing">apply</button>}
                        </div>
                        <div className="cmp-meta">
                          <span className="cmp-c">${fmt(r.cost)}/mo</span>
                          {r.availability !== undefined && <span title="This option’s own availability (uptime) — lower is the trade-off for a cheaper pick"> · avail {(r.availability * 100).toFixed(2)}%</span>}
                          {r.throughput !== undefined && <span title="Throughput this option serves at this node once sized to its SLOs"> · {fmt(r.throughput)} rps</span>}
                          {r.overflow > 0 && <span className="cmp-warn" title="Offered load this option cannot serve at this sizing (dropped)"> · drops {fmt(r.overflow)}/s</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
          </div>
          <div className="sec"><h6 data-tip="The engine’s verdict per SLO on this node: the computed value vs the band, with ok / warning / violation. End-to-end SLOs are set once in the System panel below (one home — not duplicated here). Hover a metric name to learn what it means.">Verdict</h6>
            {selVerdicts.length === 0 && <div className="vr"><span className="k">no SLO on this node</span></div>}
            {/* WORST-CASE LOAD (owner ruling: a peak is just traffic in a given environment). A node saturated at its
                worst load — the steady baseline or the worst window when a generator is shaped — carries an ordinary
                saturation violation in `verds` (fed the sweep's per-node peak), rendered as a verdict row below like
                any other, matching the canvas. No separate 'peak' row, no '@HH:MM', no dual reading. */}
            {selVerdicts.map((v, i) => (
              <div className="vr" key={i}><span className="k" data-tip={keyInfo(String(v.key)).desc}>{keyInfo(String(v.key)).label}</span><span className="v">{String(v.computed.unit) === 'ms' ? formatMs(v.computed.value) : <>{fmt(v.computed.value)} {v.computed.unit}</>} <span className={'st ' + v.status}>{v.status}</span></span></div>
            ))}
            {/* SINGLE-TRUTH LATENCY (owner decree): the selected node's full MEASURED response set (p50/p95/p99 +
                mean + samples), or an honest "no data" when the node had none. This is the latency's detail home;
                the canvas bar shows the compact p50→p99 range. A quiet model-drift row (engine health) follows. */}
            {(() => {
              const r = sel && simResponses ? simResponses.find((n) => n.id === sel) : undefined;
              if (r === undefined) return null;
              const analytic = sel ? respByNode.get(sel) : undefined;
              const drift = Number.isFinite(r.mean) && r.samples > 0 && analytic !== undefined && Number.isFinite(analytic)
                ? `${formatMs(analytic)} · drift ${r.mean - analytic >= 0 ? '+' : '−'}${formatMs(Math.abs(r.mean - analytic))} (engine model vs measured)`
                : undefined;
              return (<>
                <div className="vr"><span className="k" data-tip="This node's OWN measured request→response tail from the simulation (p50/p95/p99) — what a caller of this service actually waits for; an async call is cut. The single truth; the analytic estimate is engine-internal and not shown as a latency.">Response tail (simulated)</span><span className="v">{formatResponseTail(r)}</span></div>
                {drift && <div className="vr" hidden={HIDE_ADVANCED}><span className="k" data-tip="Engine health, not architect info: how far the internal analytic model's estimate sits from the measured mean. The reported latency is always the measurement — this is only a model-vs-reality diagnostic.">Model estimate</span><span className="v" style={{ color: 'var(--ink3)', fontWeight: 400 }}>{drift}</span></div>}
              </>);
            })()}
            {selFix && <div className="fix"><b>Fix.</b> {selFix}</div>}
          </div>
          <div className="sec" hidden={HIDE_ADVANCED}><h6>Suggested next · engine</h6>
            {suggestions.length === 0 && <p className="muted">All ports wired — no open connections.</p>}
            {suggestions.map((s) => (
              <div className="sg" key={s.port}>
                <div className="sg-h"><span>{s.dir === 'in' ? '← into' : '→ from'} <b>{s.port}</b></span><span className="chip" title={protocolNote(s.protocol)}>{s.protocol}</span></div>
                <div className="sg-opts">
                  {s.options.slice(0, 6).map((o) => (
                    <button className="sg-opt" key={o} onClick={() => onAddSuggestion(s, o)} title={`Add ${o} and wire it to ${s.port}`}>
                      <span className="ic">{iconFor(facetsOf(o).kind)}</span>{o}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="sec">
            <button className="btn" onClick={() => { studio.dispatch({ kind: 'removeNode', id: selInst.id }); onSelect(null); }}>Delete component</button>
          </div>
        </>
      )}
      {selGroup && (
        <>
          <div className="ih"><span className="ic" style={{ fontSize: 16 }}>▣</span><div><b>{selGroup.label}</b><span>boundary · {selGroup.members.length} members</span></div></div>
          <div className="sec"><h6>Group</h6>
            <div className="field"><label>label</label>
              <input type="text" key={`${selGroup.id}:${selGroup.label}`} defaultValue={selGroup.label}
                onBlur={(e) => { if (e.target.value.trim() && e.target.value !== selGroup.label) studio.dispatch({ kind: 'renameGroup', id: selGroup.id, label: e.target.value.trim() }); }} />
            </div>
          </div>
          <div className="sec"><h6>Members</h6>
            {selGroup.members.length === 0 && <p className="muted">Drag components into this boundary to add them.</p>}
            {selGroup.members.map((m) => (
              <div className="vr" key={m}><span className="k">{m}</span><button className="lnk" onClick={() => studio.dispatch({ kind: 'assignGroup', node: m, group: null })}>ungroup</button></div>
            ))}
            <button className="btn" style={{ marginTop: 10 }} onClick={() => { studio.dispatch({ kind: 'removeGroup', id: selGroup.id }); onSelect(null); }}>Delete group</button>
          </div>
        </>
      )}
      {!selInst && !selGroup && <div className="sec"><p style={{ color: 'var(--ink3)' }}>Select a component or group on the canvas to inspect it. Whole-system metrics are in the System panel below.</p></div>}
    </aside>
  );
}
