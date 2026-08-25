// signalGraph.ts
// Builds a Simulink-style signal-flow graph for a JSBSim flight_control / system
// module (one canvas for the whole module) and serializes edits back to the
// channels JSON the server already understands.
//
// Key JSBSim semantics used here:
//   * A component reads its input(s) via <input> / <property> child elements and
//     writes its result to the component's `name` (the output signal).
//   * Wiring is implicit: a consumer's input signal name == a producer's output
//     (component name). We reconstruct those edges by signal name.

import type { ExprNode } from '../types';
import { BLOCK_DEFS } from './expressionConverter';
import { exprToFormula } from './exprToFormula';
import { orderRanksByBarycenter } from './layoutUtils';

export interface ChannelItem {
  type: string;
  name: string;
  componentProps?: Record<string, any>;
  expression?: ExprNode;
  items?: ChannelItem[];
  cliptoMin?: string;
  cliptoMax?: string;
}

export interface SignalGraph {
  nodes: any[];
  edges: any[];
}

// ── Component metadata (label / icon / color) ───────────────────────────────
// Covers every component defined in JSBSimCommon.xsd <channel>. Entries are
// keyed by the raw XML element name emitted by xmlParser (e.g. "lag_filter",
// "integrator"). Components not listed here fall back to a generic "•" glyph,
// so completeness here == how many blocks the module diagram can "recognize".
export const COMPONENT_META: Record<string, { label: string; icon: string; color: string }> = {
  // ── Math / arithmetic (mirror func_group operators) ──
  function:    { label: '函数 function', icon: 'ƒ', color: '#3b82f6' },
  fcs_function:{ label: '函数 fcs_function', icon: 'ƒ', color: '#2563eb' },
  summer:      { label: '求和 summer', icon: 'Σ', color: '#f97316' },
  pure_gain:   { label: '增益 pure_gain', icon: 'G', color: '#10b981' },
  pid:         { label: 'PID 控制器', icon: 'PID', color: '#10b981' },
  integrator:  { label: '积分 integrator', icon: '∫', color: '#10b981' },
  scheduled_gain: { label: '调度增益', icon: 'G(t)', color: '#10b981' },
  bias:        { label: '偏置 bias', icon: '+b', color: '#0ea5e9' },
  constant:    { label: '常数 constant', icon: 'c', color: '#10b981' },
  difference:  { label: '差 difference', icon: '−', color: '#e11d48' },
  product:     { label: '乘积 product', icon: '×', color: '#ef4444' },
  quotient:    { label: '商 quotient', icon: '÷', color: '#dc2626' },
  pow:         { label: '幂 pow', icon: '^', color: '#be123c' },
  atan2:       { label: 'atan2', icon: 'atan2', color: '#6d28d9' },

  // ── Logic / selection ──
  switch:      { label: '开关 switch', icon: '⇄', color: '#f59e0b' },

  // ── Actuators / surfaces ──
  actuator:    { label: '作动器 actuator', icon: '⊳', color: '#ec4899' },
  aerosurface_scale: { label: '舵面比例尺', icon: '↔', color: '#8b5cf6' },
  angle:       { label: '角度 angle', icon: '∠', color: '#8b5cf6' },
  kinematic:   { label: '运动学 kinematic', icon: '⚙', color: '#8b5cf6' },
  deadband:    { label: '死区 deadband', icon: '⊓', color: '#0ea5e9' },

  // ── Filters ──
  lag_filter:  { label: '滞后 lag_filter', icon: '⏱', color: '#6366f1' },
  lead_lag_filter: { label: '超前滞后 lead_lag', icon: '⏩', color: '#6366f1' },
  second_order_filter: { label: '二阶滤波 2nd', icon: '2nd', color: '#6366f1' },
  washout_filter: { label: '洗出 washout', icon: '⊘', color: '#6366f1' },

  // ── Sensors ──
  sensor:      { label: '传感器 sensor', icon: '◉', color: '#ec4899' },
  gyro:        { label: '陀螺仪 gyro', icon: '↻', color: '#ec4899' },
  accelerometer: { label: '加速度计', icon: 'a', color: '#ec4899' },
  magnetometer: { label: '磁力计', icon: 'm', color: '#ec4899' },

  // ── Navigation ──
  waypoint_distance: { label: '航点距离', icon: '⌖', color: '#0ea5e9' },
  waypoint_heading:  { label: '航点方位', icon: '➤', color: '#0ea5e9' },

  // ── Backward-compat aliases (legacy saved files) ──
  lag:         { label: '滞后 lag', icon: '⏱', color: '#6366f1' },
  filter:      { label: '滤波 filter', icon: '2nd', color: '#6366f1' },
  aerosurface: { label: '舵面', icon: '↔', color: '#8b5cf6' },
};

// Compact arithmetic symbol for the top-level operation inside a function
// block, so the module diagram "recognizes" what math a function performs.
// Reuses the same glyph vocabulary as the expression blocks (BLOCK_DEFS).
export function functionTopSymbol(expr: ExprNode | undefined | null): string {
  if (!expr || !expr.kind) return 'ƒ';
  switch (expr.kind) {
    case 'value': {
      const v = (expr as any).value;
      return typeof v === 'number' && isFinite(v) ? String(v) : 'c';
    }
    case 'property': {
      const n = ((expr as any).name as string) || '';
      return n.split('/').pop() || 'x';
    }
    case 'function_ref': {
      const n = ((expr as any).name as string) || '';
      return (n.split('/').pop() || 'ƒ') + '()';
    }
    case 'table': return '▦';
    default: return BLOCK_DEFS[expr.kind]?.icon || 'ƒ';
  }
}

// One-line formula preview for a function block body. Returns the full
// "handwritten" math formula (× ÷ − √ sin …); the node CSS wraps it.
export function functionPreview(expr: ExprNode | undefined | null): string {
  if (!expr || !expr.kind) return '';
  const s = exprToFormula(expr);
  return s.length > 80 ? s.slice(0, 79) + '…' : s;
}

// Components that take exactly ONE <input>. Everything else (summer, product,
// difference, quotient, pow, atan2) takes multiple inputs, serialized as a
// list of <input> children. Keyed by the raw XSD element name.
export const SINGLE_INPUT_TYPES = new Set([
  'pure_gain', 'lag_filter', 'lead_lag_filter', 'second_order_filter', 'washout_filter',
  'bias', 'actuator', 'pid', 'sensor', 'gyro', 'accelerometer', 'magnetometer',
  'deadband', 'kinematic', 'aerosurface_scale', 'constant', 'integrator',
  'scheduled_gain', 'angle', 'switch', 'waypoint_distance', 'waypoint_heading',
  // legacy aliases from older saved files
  'lag', 'filter', 'aerosurface',
]);

// ── Signal extraction ───────────────────────────────────────────────────────

export function extractOutputSignal(item: ChannelItem): string {
  const out = item.componentProps?.output?.value;
  if (out && typeof out === 'string' && out.trim()) return out.trim();
  return item.name || '';
}

// Walk an expression tree collecting property / function_ref node references
// (in document order). Used both to read input signal names and to rewrite them.
export function collectPropertyNodes(expr: any, acc: any[] = []): any[] {
  if (!expr || typeof expr !== 'object') return acc;
  if (expr.kind === 'property' || expr.kind === 'function_ref') {
    acc.push(expr);
    return acc;
  }
  const branches = [
    expr.children, expr.left, expr.right, expr.base, expr.exponent,
    expr.child, expr.y, expr.x, expr.cond, expr.then, expr.else,
    expr.index, expr.default, expr.cases,
  ];
  for (const b of branches) {
    if (Array.isArray(b)) b.forEach((c: any) => collectPropertyNodes(c, acc));
    else if (b) collectPropertyNodes(b, acc);
  }
  return acc;
}

export function extractInputSignals(item: ChannelItem): string[] {
  if ((item.type === 'function' || item.type === 'fcs_function') && item.expression) {
    return collectPropertyNodes(item.expression).map(n => n.name).filter(Boolean);
  }
  // Multi-input components (e.g. summer) carry an ordered `inputs` array.
  if (Array.isArray(item.componentProps?.inputs)) {
    return (item.componentProps!.inputs as any[])
      .filter(s => s != null && String(s).trim() !== '')
      .map(s => String(s).trim());
  }
  const inputs: string[] = [];
  const input = item.componentProps?.input?.value;
  if (input && typeof input === 'string' && input.trim()) inputs.push(input.trim());
  const props = item.componentProps?.properties;
  if (Array.isArray(props)) {
    for (const p of props) if (typeof p === 'string' && p.trim()) inputs.push(p.trim());
  }
  return inputs;
}

// Build the parallel gains array for a component. For multi-input components it
// is the stored `gains` array (gains[i] scales inputs[i]). For single-input
// components it is a one-element array holding the single `gain` value.
function computeGains(item: ChannelItem): (string | undefined)[] | undefined {
  const comp = item.componentProps;
  if (comp?.gains && Array.isArray(comp.gains)) return comp.gains as (string | undefined)[];
  if (comp?.gain?.value != null && String(comp.gain.value).trim() !== '') {
    return [String(comp.gain.value)];
  }
  return undefined;
}

function setFunctionInputs(expr: any, inputs: string[]): any {
  const nodes = collectPropertyNodes(expr);
  let k = 0;
  for (const nd of nodes) {
    if (k < inputs.length) nd.name = inputs[k] || nd.name;
    k++;
  }
  return expr;
}

// ── Build graph ─────────────────────────────────────────────────────────────

const COL = 300;
const ROW = 140;

export function buildSignalGraph(
  channels: ChannelItem[],
  _topLevelProps: string[] = [],
  opts: { canvas?: { w: number; h: number } } = {},
): SignalGraph {
  const items: { item: ChannelItem; ch: number; chName: string; id: string }[] = [];
  channels.forEach((ch, ci) => {
    const chName = ch?.name || '';
    (ch.items || []).forEach((it: ChannelItem, ii: number) => {
      items.push({ item: it, ch: ci, chName, id: `c-${ci}-${ii}` });
    });
  });

  const producerOf = new Map<string, string>(); // signal -> component id
  for (const e of items) {
    const sig = extractOutputSignal(e.item);
    if (sig && !producerOf.has(sig)) producerOf.set(sig, e.id);
  }

  const consumerInputs = new Map<string, string[]>(); // component id -> input signals
  for (const e of items) consumerInputs.set(e.id, extractInputSignals(e.item));

  // Simple rank layout: rank = 1 + max(producer rank). Iterative with cap.
  const rank = new Map<string, number>();
  for (const e of items) rank.set(e.id, 0);
  for (let iter = 0; iter < items.length + 2; iter++) {
    let changed = false;
    for (const e of items) {
      const myInputs = consumerInputs.get(e.id)!;
      let r = 0;
      for (const s of myInputs) {
        const prod = producerOf.get(s);
        if (prod && prod !== e.id) r = Math.max(r, (rank.get(prod) ?? 0) + 1);
      }
      if (r > (rank.get(e.id) ?? 0)) { rank.set(e.id, r); changed = true; }
    }
    if (!changed) break;
  }

  const byRank = new Map<number, string[]>();
  for (const e of items) {
    const r = rank.get(e.id)!;
    if (!byRank.has(r)) byRank.set(r, []);
    byRank.get(r)!.push(e.id);
  }

  // Reverse index: signal -> consumer component ids (used for ordering + endpoint placement)
  const consumersOf = new Map<string, string[]>();
  for (const [id, sigs] of consumerInputs) {
    for (const s of sigs) {
      if (!s) continue;
      if (!consumersOf.has(s)) consumersOf.set(s, []);
      consumersOf.get(s)!.push(id);
    }
  }

  // Adjacency for the barycenter sweep: previous/next rank neighbours.
  const prev = new Map<string, string[]>();
  const next = new Map<string, string[]>();
  for (const e of items) {
    const id = e.id;
    const prevs = (consumerInputs.get(id) || [])
      .map((s) => producerOf.get(s))
      .filter((p): p is string => !!p && p !== id);
    prev.set(id, prevs);
    const sig = extractOutputSignal(e.item);
    if (sig) next.set(id, (consumersOf.get(sig) || []).filter((c) => c !== id));
  }

  // Order each rank to minimise edge crossings (median/barycenter heuristic).
  orderRanksByBarycenter(byRank, { prev, next });

  const nodes: any[] = [];
  const edges: any[] = [];

  for (const e of items) {
    const sig = extractOutputSignal(e.item);
    const inputs = consumerInputs.get(e.id)!;
    const gains = computeGains(e.item);
    const meta = COMPONENT_META[e.item.type] || { label: e.item.type, icon: '•', color: '#64748b' };
    const isFn = e.item.type === 'function' || e.item.type === 'fcs_function';
    const expr = isFn ? e.item.expression : undefined;
    // Normalize compProps: a PID always carries kp/ki/kd (JSBSim defaults
    // Ki/Kd to 0) so they are visible on the block and editable in the panel.
    let compProps: Record<string, any> = e.item.componentProps ? { ...e.item.componentProps } : {};
    if (e.item.type === 'pid') {
      const backfill = (k: string, dflt: string) => {
        const cur = compProps[k];
        const hasVal = cur && ((cur.value !== undefined && cur.value !== '') || (cur['#text'] !== undefined && cur['#text'] !== ''));
        if (!hasVal) compProps[k] = { value: dflt, attrs: {} };
      };
      backfill('kp', '1');
      backfill('ki', '0');
      backfill('kd', '0');
    }
    // Count how many other components consume this block's output signal
    const outputConsumers = items.filter(other => 
      other.id !== e.id && consumerInputs.get(other.id)?.includes(sig)
    ).length;
    nodes.push({
      id: e.id,
      type: 'signalBlock',
      position: { x: 0, y: 0 },
      data: {
        kind: 'component',
        itemType: e.item.type,
        name: e.item.name || '',
        outputSignal: sig,
        hasExplicitOutput: !!(e.item.componentProps?.output?.value),
        inputs,
        gains,
        expression: expr,
        // Surface the inner arithmetic of a function block in the module diagram
        exprIcon: isFn && expr ? functionTopSymbol(expr) : undefined,
        exprPreview: isFn && expr ? functionPreview(expr) : undefined,
        cliptoMin: e.item.cliptoMin,
        cliptoMax: e.item.cliptoMax,
        compProps,
        ch: e.ch,
        chName: e.chName,
        itemIdx: 0,
        meta,
        hasMultipleOutputs: outputConsumers > 1,  // Fan-out indicator
      },
    });
  }

  // Signal endpoint nodes
  const sourceIds = new Map<string, string>(); // signal -> nodeId
  const sinkIds = new Map<string, string>();
  const consumedSignals = new Set<string>();
  for (const ins of consumerInputs.values()) for (const s of ins) if (s) consumedSignals.add(s);

  for (const s of consumedSignals) {
    if (!producerOf.has(s)) {
      const nid = `src-${s}`;
      sourceIds.set(s, nid);
      nodes.push({
        id: nid, type: 'signalEnd', position: { x: 0, y: 0 },
        data: { kind: 'signal', signalRole: 'source', signalName: s },
      });
    }
  }
  for (const [sig, id] of producerOf) {
    if (!consumedSignals.has(sig)) {
      const nid = `sink-${sig}`;
      sinkIds.set(sig, nid);
      nodes.push({
        id: nid, type: 'signalEnd', position: { x: 0, y: 0 },
        data: { kind: 'signal', signalRole: 'sink', signalName: sig },
      });
    }
  }

  // ── Data-flow-driven layout ──
  // 1) Group modules by channel
  // 2) Topological-sort channels by signal dependencies (data flow direction)
  // 3) Place each channel as a column, left→right
  // 4) Within each column, order modules by barycenter of connections
  const NODE_W = 56;
  const NODE_H = 40;
  const COL_GAP = 200;   // horizontal gap between channel columns
  const ROW_GAP = 50;    // vertical gap between modules in same column

  // Group items by channel index
  const byChannel = new Map<number, typeof items>();
  for (const e of items) {
    if (!byChannel.has(e.ch)) byChannel.set(e.ch, []);
    byChannel.get(e.ch)!.push(e);
  }

  // Determine channel order by data flow: channel A → channel B if A produces
  // a signal consumed by B.  Topological sort.
  const chIds = [...byChannel.keys()].sort((a, b) => a - b);
  const chConsumers = new Map<number, Set<number>>(); // ch → set of downstream ch
  for (const e of items) {
    const outSig = extractOutputSignal(e.item);
    if (!outSig) continue;
    for (const cid of (consumersOf.get(outSig) || [])) {
      const consumer = items.find(x => x.id === cid);
      if (consumer && consumer.ch !== e.ch) {
        if (!chConsumers.has(e.ch)) chConsumers.set(e.ch, new Set());
        chConsumers.get(e.ch)!.add(consumer.ch);
      }
    }
  }
  // Topological sort of channels
  const chInDeg = new Map<number, number>();
  for (const c of chIds) chInDeg.set(c, 0);
  for (const [, downs] of chConsumers) {
    for (const d of downs) chInDeg.set(d, (chInDeg.get(d) ?? 0) + 1);
  }
  const sortedChs: number[] = [];
  const queue = chIds.filter(c => (chInDeg.get(c) ?? 0) === 0);
  while (queue.length > 0) {
    const c = queue.shift()!;
    sortedChs.push(c);
    for (const d of (chConsumers.get(c) || [])) {
      chInDeg.set(d, (chInDeg.get(d) ?? 0) - 1);
      if (chInDeg.get(d) === 0) queue.push(d);
    }
  }
  // Add any remaining channels (cycles or disconnected)
  for (const c of chIds) if (!sortedChs.includes(c)) sortedChs.push(c);

  // Assign x position per channel column
  const chX = new Map<number, number>();
  sortedChs.forEach((c, i) => { chX.set(c, 80 + i * (NODE_W + COL_GAP)); });

  // Within each channel, order modules by barycenter of their upstream connections
  const compY = new Map<string, number>(); // temporary y for ordering
  for (const chIdx of sortedChs) {
    const group = byChannel.get(chIdx)!;
    // Initial order: by original index
    group.sort((a, b) => a.id.localeCompare(b.id));

    // Barycenter sweep (2 passes)
    for (let pass = 0; pass < 3; pass++) {
      for (const e of group) {
        const ups = (consumerInputs.get(e.id) || [])
          .map(s => producerOf.get(s))
          .filter((p): p is string => !!p && p !== e.id && compY.has(p));
        if (ups.length > 0) {
          const avg = ups.reduce((s, p) => s + (compY.get(p) ?? 0), 0) / ups.length;
          compY.set(e.id, avg);
        }
      }
      group.sort((a, b) => (compY.get(a.id) ?? 0) - (compY.get(b.id) ?? 0));
    }

    // Assign final positions
    const x = chX.get(chIdx)!;
    group.forEach((e, i) => {
      const n = nodes.find(nd => nd.id === e.id);
      if (n) {
        const y = 80 + i * (NODE_H + ROW_GAP);
        n.position = { x, y };
        compY.set(e.id, y);
      }
    });
  }

  // Component bounds drive endpoint placement.
  const compNodes = nodes.filter(n => n.data.kind === 'component');
  const compXs = compNodes.map(n => n.position.x);
  const compYs = compNodes.map(n => n.position.y);
  const compMinX = compXs.length ? Math.min(...compXs) : 80;
  const compMaxX = compXs.length ? Math.max(...compXs) : 80;
  const compMinY = compYs.length ? Math.min(...compYs) : 80;
  const compMaxY = compYs.length ? Math.max(...compYs) : 80;
  const epGap = 100;
  // Sources: place in a compact column to the left of the components.
  const SOURCE_ROW = 40;
  let si = 0;
  for (const [s, nid] of sourceIds) {
    const n = nodes.find(x => x.id === nid)!;
    n.position = { x: compMinX - epGap, y: compMinY + si * SOURCE_ROW };
    si++;
  }
  let ki = 0;
  for (const [sig, nid] of sinkIds) {
    const n = nodes.find(x => x.id === nid)!;
    n.position = { x: compMaxX + epGap, y: compMinY + ki * SOURCE_ROW };
    ki++;
  }

  // Edges (wired by signal name)
  for (const e of items) {
    const inputs = consumerInputs.get(e.id)!;
    // Merge duplicate wires: a signal entering the same component at several
    // ports is drawn once (into the first such port). The full inputs list is
    // preserved for serialization (unconnected duplicate ports fall back to
    // their original signal).
    const seen = new Set<string>();
    inputs.forEach((s, i) => {
      if (!s || seen.has(s)) return;
      seen.add(s);
      const prod = producerOf.get(s);
      const source = (prod && prod !== e.id) ? prod : sourceIds.get(s)!;
      edges.push({
        id: `e-${source}-${e.id}-${i}`,
        source,
        sourceHandle: 'out',
        target: e.id,
        targetHandle: `in-${i}`,
        label: s,
        data: { signal: s },
        type: 'signal',
      });
    });
  }
  for (const [sig, nid] of sinkIds) {
    const prod = producerOf.get(sig)!;
    edges.push({
      id: `e-${prod}-${nid}`,
      source: prod, sourceHandle: 'out', target: nid, targetHandle: 'in',
      label: sig, data: { signal: sig }, type: 'signal',
    });
  }

  // ── Separate overlapping signal lines ──
  // Fan edges out from shared source/target handles by a small vertical offset
  // (visual only; the wiring/signal mapping is unchanged). Reduces the cases
  // where two wires run on top of each other.
  assignSignalEdgeOffsets(edges);

  return { nodes, edges };
}

/**
 * Assign a small per-edge vertical offset so wires sharing a source handle
 * (fan-out) or a target handle (fan-in) don't lie exactly on top of each other.
 * Purely visual: `data.srcOffset` / `data.tgtOffset` are read by SignalEdge.
 *
 * Note: spread=0 means all wires from the same handle exit from the same point.
 */
export function assignSignalEdgeOffsets(edges: any[], spread = 0): any[] {
  const bySrc = new Map<string, any[]>();
  const byTgt = new Map<string, any[]>();
  for (const e of edges) {
    if (!bySrc.has(e.source)) bySrc.set(e.source, []);
    bySrc.get(e.source)!.push(e);
    if (!byTgt.has(e.target)) byTgt.set(e.target, []);
    byTgt.get(e.target)!.push(e);
  }
  const fan = (list: any[]) => {
    const mid = (list.length - 1) / 2;
    list.forEach((e, i) => {
      const off = (i - mid) * spread;
      e.data = e.data || {};
      e.data.srcOffset = off;
    });
  };
  const fanTgt = (list: any[]) => {
    const mid = (list.length - 1) / 2;
    list.forEach((e, i) => {
      const off = (i - mid) * spread;
      e.data = e.data || {};
      e.data.tgtOffset = off;
    });
  };
  for (const l of bySrc.values()) fan(l);
  for (const l of byTgt.values()) fanTgt(l);
  return edges;
}

// ── Serialize graph back to channels JSON ───────────────────────────────────

function cloneExpr(e: any): any {
  return e ? JSON.parse(JSON.stringify(e)) : { kind: 'value', value: 0 };
}

export function graphToChannels(nodes: any[], edges: any[]): any[] {
  const compNodes = nodes.filter(n => n.data?.kind === 'component');
  compNodes.sort((a, b) => (a.position.x - b.position.x) || (a.position.y - b.position.y));

  // target node -> (port index -> signal)
  const inputMap = new Map<string, Map<number, string>>();
  for (const e of edges) {
    if (e.targetHandle && typeof e.targetHandle === 'string' && e.targetHandle.startsWith('in-')) {
      const idx = parseInt(e.targetHandle.slice(3), 10);
      if (isNaN(idx)) continue;
      const sig = e.data?.signal ?? '';
      if (!inputMap.has(e.target)) inputMap.set(e.target, new Map());
      inputMap.get(e.target)!.set(idx, sig);
    }
  }

  const channels: any[] = [];
  const ensureChannel = (ch: number, name: string) => {
    if (!channels[ch]) channels[ch] = { name: name || '', items: [] };
    return channels[ch];
  };

  for (const n of compNodes) {
    const d = n.data;
    const inputsMap = inputMap.get(n.id) || new Map();
    const inputs: string[] = [];
    let k = 0;
    while (inputsMap.has(k)) { inputs.push(inputsMap.get(k)!); k++; }
    // Fallback to the previously-known signal name for ports without an edge
    for (let i = 0; i < (d.inputs?.length || 0); i++) {
      if (inputs[i] === undefined) inputs[i] = d.inputs[i] || '';
    }

    let item: any;
    if (d.itemType === 'function' || d.itemType === 'fcs_function') {
      const expr = cloneExpr(d.expression);
      setFunctionInputs(expr, inputs);
      item = { type: d.itemType, name: d.name || '', expression: expr };
      if (d.cliptoMin !== undefined) item.cliptoMin = d.cliptoMin;
      if (d.cliptoMax !== undefined) item.cliptoMax = d.cliptoMax;
    } else {
      const compProps = { ...(d.compProps || {}) };
      delete compProps.input;
      delete compProps.output;
      delete compProps.properties;
      delete compProps.gains;
      if (SINGLE_INPUT_TYPES.has(d.itemType)) {
        compProps.input = { value: inputs[0] || '', attrs: {} };
        if (d.gains && d.gains[0] != null && String(d.gains[0]).trim() !== '') {
          compProps.gain = { value: String(d.gains[0]), attrs: {} };
        }
      } else {
        // Multi-input component (summer, etc.): keep the ordered inputs list
        // and a parallel gains array so the interleaved <input>/<gain> pairing
        // round-trips losslessly.
        compProps.inputs = inputs;
        compProps.gains = (d.gains && Array.isArray(d.gains)) ? d.gains : inputs.map(() => undefined);
      }
      // Only emit <output> when the original component had an explicit one;
      // otherwise JSBSim binds the output to the component `name` automatically.
      if (d.hasExplicitOutput && d.outputSignal) {
        compProps.output = { value: d.outputSignal, attrs: {} };
      }
      item = { type: d.itemType, name: d.name || '', componentProps: compProps };
    }

    const ch = (typeof d.ch === 'number' && d.ch >= 0) ? d.ch : 0;
    ensureChannel(ch, d.chName).items.push(item);
  }

  return channels.filter(Boolean).map(c => ({ name: c.name || '', items: c.items }));
}
