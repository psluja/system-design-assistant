import { createContext, useContext } from 'react';
import { Handle, Position, NodeResizer, getSmoothStepPath, EdgeLabelRenderer, type NodeProps, type EdgeProps } from '@xyflow/react';
import type { Studio } from '@sda/core';
import { iconFor } from './icons';
import { fmt } from './format';
import { protocolNote } from '@sda/content';
import { type EdgePill, type LatencyRangeBar, type RateRow } from '@sda/presenter';
// Smart orthogonal edge routing (avoids node + group boxes). FlowEdge draws the precomputed route when the shell
// threads one, else falls back to the default getSmoothStep look.
import { orthogonalPathD, pointAlongPolyline, type RoutedWire } from '@sda/presenter';

// The custom React Flow node/edge renderers + the shared types their `data` carries. Extracted from app.tsx so
// the canvas view is a self-contained module; app.tsx builds the nodes/edges and owns the interaction handlers.

/** A verdict chip tone. */
export type Tone = 'ok' | 'warn' | 'bad' | '';
/** A verdict status (or unknown / not-computed). */
export type Status = 'ok' | 'warning' | 'violation' | 'unknown' | undefined;
export type NodePort = { name: string; dir: 'in' | 'out' | 'bi'; accepts?: readonly string[]; speaks?: readonly string[]; wired?: boolean };
/** The RATE row a node shows in ONE FORM (the presenter's {@link RateRow}). A capacity-bearing tier renders the ρ
 *  utilisation meter (rate · % · fill); a capacity-less tier (a source / origin, a pure-delay hop) renders the SAME
 *  row with the rate alone. All values are computed by content (nodeQueues + the forward pass) — the shell renders
 *  them (web-is-a-dumb-renderer). Absent only for a node with no rate at all. */
export type NodeLoad = RateRow;
/** The direction a "+" add flows relative to the SOURCE port: an OUT (or bi) port feeds a NEW node downstream
 *  (placed to the right); an IN port is fed BY a new node upstream (placed to the left). */
export type PortDir = 'out' | 'in';
/** The `data` payload app.tsx puts on an `sda` node. SINGLE-TRUTH LATENCY (owner decree): the latency bar is the
 *  MEASURED p50→p99 range (the presenter's `latencyRangeBar`) — p50 "typical" on the left, p99 "tail" on the right,
 *  verdict-toned — or absent when the DES has measured nothing (no analytic fallback). `refreshing` dims it while a
 *  fresh sim is in flight (the last measurement stays; never a flicker/swap). */
export type SdaNodeData = {
  name: string; desc: string; id: string; ty: string; kind: string;
  chips: { t: string; k: Tone }[]; flag: boolean; ports: NodePort[]; load?: NodeLoad; lat?: LatencyRangeBar; refreshing?: boolean;
  /** ASSIGNED PORT POSITIONS (R5, the port slide): `${'in'|'out'}:${portName}` → px from the node's top at which
   *  that handle sits — the presenter's `assignPortOffsets` output for this node, threaded by the shell after a
   *  ✨ layout so a wired handle sits exactly opposite its peer (the router anchors from the SAME map — one home).
   *  A missing key (or absent map — e.g. Tidy alone) keeps the fraction position (i+1)/(n+1): no surprise motion
   *  outside the sparkle. */
  portOffsets?: Readonly<Record<string, number>>;
  /** Threaded from the shell: clicking the inline "+" on an OPEN (unwired) port opens the legality-filtered
   *  quick-add for that port. `dir` is the port's flow direction (out ⇒ place a new node to the right, feeding
   *  it; in ⇒ to the left, fed by it). Absent ⇒ no "+" is shown (e.g. a read-only render). */
  onPortAdd?: (nodeId: string, port: string, dir: PortDir) => void;
};

/** The CSS `top` for a handle/label at index `i` of `n` same-side ports: the ASSIGNED offset (px from node top)
 *  when the slide set one, else the fraction (i+1)/(n+1) — the same resolution order as the router's
 *  `portAnchorOffset`, so what renders is exactly what routes. Exported for the render-logic tests (both shells
 *  render through this one function). */
export const handleTop = (offsets: Readonly<Record<string, number>> | undefined, side: 'in' | 'out', portName: string, i: number, n: number): string => {
  const off = offsets?.[`${side}:${portName}`];
  return off !== undefined ? `${off}px` : `${((i + 1) * 100) / (n + 1)}%`;
};

/** Utilisation tone: comfortable < 70%, tight 70–95%, at/over capacity ≥ 95% (ρ→1 ⇒ unbounded queue). */
const loadTone = (rho: number): Tone => (rho >= 0.95 ? 'bad' : rho >= 0.7 ? 'warn' : 'ok');

/** RPS — ONE FORM. Every flow-node renders its rate in this SAME row. A capacity-BEARING tier (finite, positive
 *  capacity) gets the ρ utilisation meter (rate · % · fill); a capacity-LESS tier (a source / origin, a pure-delay
 *  hop) gets the SAME row with the rate alone, verdict-toned. The presenter builds the view-model (rateRow); this
 *  only paints it, so both shells show the identical rate row. */
function RateMeter({ load }: { load: NodeLoad }): JSX.Element {
  const { offered, capacity, rho, tone } = load;
  // WORST-CASE LOAD (owner ruling: a peak is just traffic in a given environment). The ρ shown is the worst load the
  // declared environment produces — the worst-window ρ when a generator is shaped, else the steady ρ (byte-identical
  // to today). A violation is a violation: the meter reads red when ρ saturates, with no separate 'peak' / '@HH:MM'
  // framing. Whether the tier breaks is the ONE truth the shared verdict list also carries (so canvas = MCP = doc).
  if (capacity !== undefined && Number.isFinite(capacity) && rho !== undefined) {
    return (
      <div className="meter" title={`Real load ${fmt(offered)} of ${fmt(capacity)} rps capacity — ρ ${Math.round(rho * 100)}%`}>
        <div className="meter-h">
          <span className="meter-nums">{fmt(offered)} / {fmt(capacity)} rps</span>
          <span className={'meter-pct ' + loadTone(rho)}>{Math.round(rho * 100)}%{rho >= 1 ? ' ⚠' : ''}</span>
        </div>
        <div className="meter-track"><div className={'meter-fill ' + loadTone(rho)} style={{ width: `${Math.min(100, rho * 100)}%` }} /></div>
      </div>
    );
  }
  // Capacity-less: the SAME row, rate alone (no ceiling to bar against), toned by the node's verdict.
  return (
    <div className="meter" title={`Offered load ${fmt(offered)} rps — no capacity ceiling declared on this tier`}>
      <div className="meter-h">
        <span className={'meter-nums' + (tone ? ' ' + tone : '')}>{fmt(offered)} rps</span>
      </div>
    </div>
  );
}
/** The latency bar's verdict tone → its CSS modifier class. The presenter's `latencyRangeBar` decides the tone (the
 *  node's own latency/tailLatency verdict); the shell only maps it to a class — no domain/formatting logic here. */
const latBarClass = (tone: LatencyRangeBar['tone']): string => (tone ? ` ${tone}` : '');
/** Which end of the wire a transform sits on, and the source (node, port) it belongs to — threaded to the shell's
 *  edit callback so a pill click opens the RIGHT port's transform editor (doc: flow-transformations-r2 §3). */
export type TransformClick = (wire: number, node: string, port: string, side: 'out' | 'in') => void;
/** The `data` payload on a `flow` edge — both animation channels are sourced from the live evaluation, and (R2) the
 *  transform PILLS the shared presenter computed for this wire, plus the click callback the shell threads in. */
export type FlowEdgeData = {
  status: Status;
  rate: number | undefined;
  latency: number | undefined;
  saturated?: boolean;
  /** This wire's index in doc.wires (`w${i}`), so a pill click addresses the same edge the shell edits. */
  wire?: number;
  /** The wire's [sourceNode, sourcePort] / [targetNode, targetPort] — a pill maps to the port it edits. */
  from?: readonly [string, string];
  to?: readonly [string, string];
  /** Persistent transform pills (0..2) from the presenter's edgeRates — an amber amp, a teal reduce, etc. */
  pills?: readonly EdgePill[];
  /** The exact rate this wire delivers, shown on HOVER for a quiet identity edge (no persistent pill). */
  carried?: number | undefined;
  /** Threaded from the shell: a pill click opens that port's transform editor (popover). Absent ⇒ read-only. */
  onTransformClick?: TransformClick;
  /** The GUARANTEE STRIP segment for this edge (doc: guarantee-propagation §4) — present ONLY when the SELECTED
   *  flow carries a guarantee REQUIREMENT and this wire is on its path. `tone`: teal while the running meet still
   *  satisfies the floor, red from the degrading hop onward, gray for unknown. `hover` names the transition. Absent
   *  ⇒ zero strip pixels (no-filler — a design/flow with no requirement draws nothing). */
  guarantee?: { readonly tone: 'ok' | 'bad' | 'unknown'; readonly hover: string };
  /** SMART ROUTE (edge-routing.ts): the precomputed orthogonal polyline that avoids node + group boxes. Present
   *  only when the shell's routing toggle is on and a clear path was found; absent ⇒ the default getSmoothStep
   *  wire is drawn. Its endpoints are re-snapped to React Flow's live handle coords at render time. */
  route?: RoutedWire;
};

/** The strip stroke colour per tone (teal satisfies · red broken · gray unknown) — a slim band UNDER the wire, read
 *  distinctly from the animated health stroke and the transform pills. */
const STRIP_COLOR: Record<NonNullable<FlowEdgeData['guarantee']>['tone'], string> = {
  ok: 'var(--ok)',
  bad: 'var(--bad)',
  unknown: 'var(--muted, #8b8fa3)',
};

/** The tone→CSS-class map for a transform pill: amber amplify, teal reduce, gray ceiling, dashed prob (doc §3). */
const pillClass = (tone: EdgePill['tone']): string => `edge-pill tp-${tone}`;
/** The `data` payload on a `group` boundary node. */
export type GroupData = { label: string };

/** Context so the (top-level) group node can dispatch resize/rename without prop-drilling. */
export const StudioCtx = createContext<Studio | null>(null);

// Native hover tooltip for a port, so legality is PREDICTABLE before a drag: an in/bi port lists what it
// ACCEPTS, an out/bi port what it SPEAKS — one line per protocol with its FULL official name/spec (ids are
// what the UI displays; the hover carries the specification).
const specLine = (id: string): string => {
  const note = protocolNote(id);
  return note === undefined ? id : `${id} — ${note}`;
};
const portTip = (p: NodePort, side: 'in' | 'out'): string =>
  side === 'in' ? `accepts:\n${(p.accepts ?? []).map(specLine).join('\n')}` : `speaks:\n${(p.speaks ?? []).map(specLine).join('\n')}`;

// --- custom React Flow node: one labelled Handle per manifest port, so connections are per-port ---
function SdaNode({ data }: NodeProps): JSX.Element {
  const d = data as SdaNodeData;
  const ins = (d.ports ?? []).filter((p) => p.dir === 'in' || p.dir === 'bi');
  const outs = (d.ports ?? []).filter((p) => p.dir === 'out' || p.dir === 'bi');
  // Handle/label vertical position: the ASSIGNED slide offset when present (R5 — the wire's anchor row), else the
  // manifest fraction. One resolution ({@link handleTop}) for the handle, its label and its "+" slot, so all three
  // ride together.
  const top = (side: 'in' | 'out', p: NodePort, i: number, n: number): string => handleTop(d.portOffsets, side, p.name, i, n);
  const minHeight = Math.max(ins.length, outs.length, 1) * 19 + 46;
  // The inline "+" on an OPEN (unwired) port (TASK-71): a hover-revealed affordance that opens the SAME
  // legality-filtered quick-add the drop-to-pick flow uses, for exactly this port. Rendered only when the shell
  // threaded `onPortAdd` AND the port is unwired, so a wired port keeps today's look exactly. It sits just OUTSIDE
  // the label (own hit-area, pointer-events on) and calls the callback — never disturbing the handle drag. The
  // click is stopped from bubbling so it selects nothing / starts no drag.
  const plus = (p: NodePort, dir: PortDir): JSX.Element | null =>
    d.onPortAdd === undefined || p.wired ? null : (
      <button
        type="button"
        className={'port-plus ' + (dir === 'out' ? 'ppR' : 'ppL')}
        title="Add what fits…"
        aria-label={`Add a component to ${p.name}`}
        // nodrag stops React Flow from treating the press as a node drag; stopPropagation keeps it off the canvas.
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); d.onPortAdd?.(d.id, p.name, dir); }}
      >
        {/* ONE vector icon (circle + plus in a single SVG): a font glyph sat visibly below the geometric
            centre and hand-drawn CSS bars looked crude — a real icon is crisp at every zoom/DPI. */}
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <circle cx="8" cy="8" r="7.25" className="pp-ring" />
          <path d="M8 4.6 V11.4 M4.6 8 H11.4" className="pp-cross" />
        </svg>
      </button>
    );
  return (
    <div className="node" style={{ minHeight }}>
      {d.flag && <span className="flag">!</span>}
      {ins.map((p, i) => (
        <span key={'i' + p.name}>
          <Handle id={p.name} type="target" position={Position.Left} style={{ top: top('in', p, i, ins.length) }} title={portTip(p, 'in')} />
          <span className="port portL" style={{ top: top('in', p, i, ins.length) }} title={portTip(p, 'in')}>{p.name}</span>
          {/* a bi port feeds downstream on its "+", so only pure-in ports add to the LEFT */}
          {p.dir === 'in' && plus(p, 'in') !== null && <span className="port-plus-slot ppsL" style={{ top: top('in', p, i, ins.length) }}>{plus(p, 'in')}</span>}
        </span>
      ))}
      {outs.map((p, i) => (
        <span key={'o' + p.name}>
          <Handle id={p.name} type="source" position={Position.Right} style={{ top: top('out', p, i, outs.length) }} title={portTip(p, 'out')} />
          <span className="port portR" style={{ top: top('out', p, i, outs.length) }} title={portTip(p, 'out')}>{p.name}</span>
          {plus(p, 'out') !== null && <span className="port-plus-slot ppsR" style={{ top: top('out', p, i, outs.length) }}>{plus(p, 'out')}</span>}
        </span>
      ))}
      <div className="hd">
        <span className="ic">{iconFor(d.kind)}</span>
        <div style={{ minWidth: 0 }}>
          <div className="nm">{d.name}</div>
          {d.desc && <div className="desc" title={d.desc}>{d.desc}</div>}
          <div className="ty">{d.id} · {d.ty}</div>
        </div>
      </div>
      {/* RPS — ONE FORM: every node's rate rides this SAME row (RateMeter). Capacity-bearing ⇒ the ρ meter (rate ·
          % · fill); capacity-less (a source / origin, a pure-delay hop) ⇒ the same row, rate alone. */}
      {d.load && <RateMeter load={d.load} />}
      {/* SINGLE-TRUTH LATENCY (owner decree): the MEASURED p50→p99 range — p50 "typical" (calm) on the left, p99
          "tail" (warning-leaning) on the right, verdict-toned, with the fill gradient-ing between the two anchors.
          Present only when the DES has measured this node (measured-or-nothing); `refreshing` dims it while a fresh
          sim is in flight (the last measurement stays put — never a flicker or a swap to an analytic value). The
          presenter builds the named anchors + tooltip; the shell only paints them (web-is-a-dumb-renderer). */}
      {d.lat && (
        <div className={'latbar' + latBarClass(d.lat.tone) + (d.refreshing ? ' refreshing' : '')} title={d.lat.tooltip}>
          <div className="latbar-nums">
            <span className="lat-typical">{d.lat.typical}</span>
            <span className="lat-arrow" aria-hidden="true">→</span>
            <span className="lat-tail">{d.lat.tail}</span>
          </div>
          <div className="latbar-track"><div className="latbar-range" /></div>
        </div>
      )}
      <div className="mt">{d.chips.map((c, i) => <span key={i} className={'chip ' + c.k}>{c.t}</span>)}</div>
    </div>
  );
}

// --- custom animated edge. Two independent visual channels, both sourced from the live evaluation:
//   • the dashed stroke marches at a speed ∝ THROUGHPUT (busier wire ⇒ faster dashes), and
//   • a "packet" dot travels source→target→source on a ROUND TRIP whose duration ∝ this hop's LATENCY
//     (slower dot ⇒ the destination adds more latency). The dot is hidden when latency is unknown — the
//     tool never fakes a number. Colour (both channels) = the downstream node's verdict status. ---
function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data }: EdgeProps): JSX.Element {
  // ORTHOGONAL (right-angle) routing — the architecture-DIAGRAM look (draw.io / C4), not a flow-chart curve.
  // A small corner radius keeps it elegant; the packet dot follows the same path via <mpath>.
  const ed = data as FlowEdgeData | undefined;
  // SMART ORTHOGONAL ROUTING: if the shell threaded a precomputed route (it avoids the node + group boxes), draw
  // THAT — but snap its two ends to React Flow's live handle coordinates so the wire stays glued to the node
  // while it is dragged (the interior re-routes on drag-commit). No route ⇒ the original getSmoothStep look.
  const route = ed?.route;
  let path: string;
  let labelX: number;
  let labelY: number;
  let inX: number;
  let inY: number;
  if (route !== undefined && route.points.length >= 2) {
    // Re-anchor the presenter router's polyline onto React Flow's LIVE handles WITHOUT a diagonal stitch at the
    // port. The router anchors its endpoints at portFraction·box.h (edge-routing.ts), which can sit a few px off
    // the actually-rendered handle; swapping ONLY the two endpoints for the live coords would leave the first/last
    // segment slanted (its far end is still the router's anchor row). So we also slide the ADJACENT interior point
    // onto the live handle's axis, keeping that segment's ORIGINAL orientation — its perpendicular neighbour is
    // untouched, so the rest of the route stays orthogonal. A 2-point (straight) route has no interior point: it is
    // just the segment between the two live handles. Deterministic; a pure re-projection of the router's output.
    const rp = route.points;
    const lastIdx = rp.length - 1;
    const pts = rp.map((p) => ({ x: p.x, y: p.y }));
    pts[0] = { x: sourceX, y: sourceY };
    pts[lastIdx] = { x: targetX, y: targetY };
    if (lastIdx - 1 >= 1) {
      const rp0 = rp[0];
      const rp1 = rp[1];
      const first = pts[1];
      // first router segment horizontal (constant Y) ⇒ share the source handle's Y; vertical ⇒ share its X.
      if (rp0 !== undefined && rp1 !== undefined && first !== undefined) pts[1] = rp0.y === rp1.y ? { x: first.x, y: sourceY } : { x: sourceX, y: first.y };
    }
    if (lastIdx - 1 >= 1) {
      const rpL = rp[lastIdx];
      const rpL1 = rp[lastIdx - 1];
      const penult = pts[lastIdx - 1]; // re-read from `pts` so a single shared corner (a 3-point route) composes with the start slide above
      if (rpL !== undefined && rpL1 !== undefined && penult !== undefined) pts[lastIdx - 1] = rpL.y === rpL1.y ? { x: penult.x, y: targetY } : { x: targetX, y: penult.y };
    }
    path = orthogonalPathD(pts, 4);
    const mid = pointAlongPolyline(pts, 0.5);
    labelX = mid.x;
    labelY = mid.y;
    // IN-side pill sits ~80% along the ROUTED wire (so it hugs the door even around a detour).
    const inp = pointAlongPolyline(pts, 0.8);
    inX = inp.x;
    inY = inp.y;
  } else {
    const [ssPath, ssLabelX, ssLabelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 4 });
    path = ssPath;
    labelX = ssLabelX;
    labelY = ssLabelY;
    inX = sourceX + (targetX - sourceX) * 0.8;
    inY = sourceY + (targetY - sourceY) * 0.8;
  }
  const status = ed?.status;
  // Colour = real HEALTH: a saturated (dropping) destination is red even with no SLO set — the timeout signal
  // must never be hidden behind a calm green just because the user has not declared a band.
  const color = status === 'violation' || ed?.saturated ? 'var(--bad)' : status === 'warning' ? 'var(--warn)' : status === 'ok' ? 'var(--ok)' : 'var(--edge)';
  const rate = ed?.rate ?? 0;
  const dashDur = Math.min(3, Math.max(0.35, 900 / Math.max(rate, 1)));
  // Round-trip travel time ∝ latency (ms), clamped so a ~0-ms hop still reads as "fast" and a multi-second
  // hop stays watchable rather than frozen. Tidy layout keeps columns ~uniform, so travel time reads as speed.
  // A SATURATED destination forces the dot to crawl — the queue backs up, so the real latency is huge; the
  // no-queue figure would wrongly race it. (Precise queueing speed arrives with the queueing-aware latency.)
  const lat = ed?.latency;
  const trip = ed?.saturated ? 6.5 : lat !== undefined && lat > 0 ? Math.min(6.5, Math.max(0.6, lat / 55)) : undefined;

  // R2 — RATES ON THE WIRE (doc: flow-transformations-r2 §3). A pill click routes to the shell's transform editor
  // for the OWNING port: an OUT-side pill edits the SOURCE port, an IN-side pill the TARGET port. Absent callback
  // (a read-only render) ⇒ the pill is a plain, non-interactive badge.
  const pills = ed?.pills ?? [];
  const onClick = ed?.onTransformClick;
  const editPort = (p: EdgePill): void => {
    if (onClick === undefined || ed?.wire === undefined) return;
    const [node, port] = p.side === 'out' ? (ed.from ?? ['', '']) : (ed.to ?? ['', '']);
    onClick(ed.wire, node, port, p.side);
  };
  // OUT-side pills sit mid-edge (the sender's emission); IN-side pills hug the target end with a chevron (the
  // receiver's consumption). `inX`/`inY` were positioned above — ~80% along the routed wire, or along the naive line.
  const identity = pills.length === 0;

  const guarantee = ed?.guarantee;
  return (
    <>
      <path id={id} className="react-flow__edge-path sda-edge" d={path} markerEnd={markerEnd} style={{ stroke: color, animationDuration: `${dashDur}s` }} />
      {/* GUARANTEE STRIP (doc: guarantee-propagation §4) — a slim band riding UNDER the wire, drawn ONLY when the
          selected flow declares a requirement this wire participates in. Same path geometry, a low, thick,
          semi-transparent stroke offset downward so it reads as a separate "promise" band distinct from the health
          stroke and the transform pills. Teal = the promise holds here; red = broken from this hop on; gray = unknown.
          A <title> gives the native hover ("ordering: per-key → none — a fan-out keeps no order"). No requirement /
          not on the flow ⇒ `guarantee` is absent and nothing is drawn (zero pixels). */}
      {guarantee !== undefined && (
        <path
          className="sda-guarantee-strip"
          d={path}
          fill="none"
          strokeWidth={5}
          strokeLinecap="round"
          stroke={STRIP_COLOR[guarantee.tone]}
          style={{ opacity: 0.55, transform: 'translateY(6px)', pointerEvents: 'stroke' }}
        >
          <title>{guarantee.hover}</title>
        </path>
      )}
      {/* an invisible fat overlay makes the thin wire easy to HOVER (for the identity rate) and SELECT without
          fighting the animated dashes; it never paints, so the diagram stays clean. */}
      <path className="sda-edge-hit" d={path} fill="none" strokeWidth={16} stroke="transparent" />
      {trip !== undefined && (
        <circle className="sda-dot" r={3.2} fill={color}>
          <animateMotion dur={`${trip}s`} repeatCount="indefinite" keyPoints="0;1;0" keyTimes="0;0.5;1" calcMode="linear">
            <mpath href={`#${id}`} />
          </animateMotion>
        </circle>
      )}
      <EdgeLabelRenderer>
        {/* IDENTITY edge: no persistent label — the exact carried rate appears only on HOVER (a quiet tooltip-pill),
            so 50 unremarkable 1:1 wires do not drown the canvas in numbers (doc §3, rule 1). */}
        {identity && ed?.carried !== undefined && (
          <div
            className="edge-hoverpill nodrag nopan"
            style={{ transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)` }}
          >
            {fmt(ed.carried)} /s
          </div>
        )}
        {/* TRANSFORMED edge: a persistent pill per side. Tone = the shape (amber amp · teal reduce · gray cap ·
            dashed prob). Clicking it opens the owning port's transform editor. `nodrag`/`nopan` keep the canvas still. */}
        {pills.map((p) => {
          const at = p.side === 'out' ? { x: labelX, y: labelY } : { x: inX, y: inY };
          const clickable = onClick !== undefined;
          return (
            <button
              key={p.side}
              type="button"
              className={pillClass(p.tone) + (p.side === 'in' ? ' edge-pill-in' : '') + (clickable ? '' : ' edge-pill-ro')}
              style={{ transform: `translate(-50%,-50%) translate(${at.x}px,${at.y}px)` }}
              title={`${p.transform.kind}(${p.transform.kind === 'generate' ? p.transform.level : p.transform.value})${p.rate !== undefined ? ` — this wire carries ${fmt(p.rate)}/s` : ' — no traffic origin yet'}${clickable ? ' · click to edit' : ''}`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); editPort(p); }}
              disabled={!clickable}
            >
              {p.side === 'in' && <span className="edge-pill-chev" aria-hidden="true">›</span>}
              {p.label}
            </button>
          );
        })}
      </EdgeLabelRenderer>
    </>
  );
}

// --- group / boundary container: a real React Flow parent node, so its members move with it ---
function GroupNode({ id, data, selected }: NodeProps): JSX.Element {
  const studio = useContext(StudioCtx);
  const d = data as GroupData;
  return (
    <div className={'groupbox' + (selected ? ' sel' : '')}>
      <NodeResizer
        isVisible={!!selected}
        minWidth={160}
        minHeight={110}
        lineClassName="gr-line"
        handleClassName="gr-handle"
        onResizeEnd={(_, p) => studio?.dispatch({ kind: 'resizeGroup', id, x: p.x, y: p.y, w: p.width, h: p.height })}
      />
      <div className="gr-label">{d.label}</div>
    </div>
  );
}

export const nodeTypes = { sda: SdaNode, group: GroupNode };
export const edgeTypes = { flow: FlowEdge };
