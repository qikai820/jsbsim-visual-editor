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

import type { ExprNode, ExprTable } from '../types';
import dagre from 'dagre';
import { BLOCK_DEFS } from './expressionConverter';
import { exprToFormula } from './exprToFormula';
import { orderRanksByBarycenter } from './layoutUtils';

export interface ChannelItem {
  type: string;
  name: string;
  output?: string;
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

function signalNodeSize(node: any): { width: number; height: number } {
  if (node.data?.kind === 'signal') return { width: 126, height: 30 };
  const type = node.data?.itemType;
  const inputs = Math.max(1, node.data?.inputs?.length || 0);
  if (type === 'pure_gain' || type === 'scheduled_gain') return { width: 62, height: 46 };
  if (type === 'summer') return { width: 72, height: Math.max(62, 34 + inputs * 22) };
  if (type === 'pid') return { width: 88, height: 60 };
  return { width: 94, height: Math.max(54, 30 + inputs * 18) };
}

/** Global compact layout with hard rectangular node separation. */
function applyDagreSignalLayout(
  nodes: any[], edges: any[], canvas?: { w: number; h: number },
): void {
  const graph = new dagre.graphlib.Graph({ multigraph: true, compound: false });
  graph.setGraph({
    rankdir: 'LR',
    ranker: 'network-simplex',
    acyclicer: 'greedy',
    align: 'UL',
    // When a real canvas is available, start slightly denser. The subsequent
    // fit pass below expands a small graph or centres a large graph as needed.
    nodesep: canvas ? 26 : 34,
    edgesep: 14,
    ranksep: canvas ? 82 : 118,
    marginx: canvas ? 26 : 70,
    marginy: canvas ? 26 : 60,
  });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) graph.setNode(node.id, signalNodeSize(node));
  // A high edge weight makes the network-simplex ranker prefer compact ranks
  // and short paths while the ordering pass still minimises crossings.
  for (const edge of edges) {
    graph.setEdge(edge.source, edge.target, { edgeId: edge.id, weight: 12, minlen: 1 }, edge.id);
  }
  dagre.layout(graph);

  // Local wire-length refinement. Dagre gives the globally valid ranks/order;
  // within each rank, pull a block toward the median of all its neighbours.
  // The forward + backward packing passes preserve order and a hard rectangle
  // gap, so this can only shorten links without creating module overlap.
  const layout = new Map<string, { x: number; y: number; w: number; h: number; rank: number }>();
  const byRank = new Map<number, string[]>();
  for (const node of nodes) {
    const p = graph.node(node.id);
    const size = signalNodeSize(node);
    const rank = Number((p as any).rank ?? Math.round(p.x / 10));
    layout.set(node.id, { x: p.x, y: p.y, w: size.width, h: size.height, rank });
    if (!byRank.has(rank)) byRank.set(rank, []);
    byRank.get(rank)!.push(node.id);
  }
  const neighbours = new Map<string, string[]>();
  for (const edge of edges) {
    if (!neighbours.has(edge.source)) neighbours.set(edge.source, []);
    if (!neighbours.has(edge.target)) neighbours.set(edge.target, []);
    neighbours.get(edge.source)!.push(edge.target);
    neighbours.get(edge.target)!.push(edge.source);
  }
  const ranks = [...byRank.keys()].sort((a, b) => a - b);
  const GAP_Y = 30;
  for (let pass = 0; pass < 6; pass++) {
    const rankOrder = pass % 2 ? [...ranks].reverse() : ranks;
    for (const rank of rankOrder) {
      const ids = byRank.get(rank)!;
      ids.sort((a, b) => layout.get(a)!.y - layout.get(b)!.y || a.localeCompare(b));
      const desired = new Map<string, number>();
      for (const id of ids) {
        const ys = (neighbours.get(id) || [])
          .map(n => layout.get(n)?.y)
          .filter((v): v is number => v !== undefined)
          .sort((a, b) => a - b);
        desired.set(id, ys.length ? ys[Math.floor(ys.length / 2)] : layout.get(id)!.y);
      }
      // Forward packing gives every rectangle its required lower bound.
      for (let i = 0; i < ids.length; i++) {
        const current = layout.get(ids[i])!;
        const previous = i ? layout.get(ids[i - 1])! : undefined;
        const minY = previous ? previous.y + previous.h / 2 + GAP_Y + current.h / 2 : -Infinity;
        current.y = Math.max(desired.get(ids[i])!, minY);
      }
      // Backward packing removes excess whitespace while retaining the gap.
      for (let i = ids.length - 2; i >= 0; i--) {
        const current = layout.get(ids[i])!;
        const next = layout.get(ids[i + 1])!;
        const maxY = next.y - next.h / 2 - GAP_Y - current.h / 2;
        current.y = Math.min(current.y, maxY);
      }
    }
  }
  for (const node of nodes) {
    const p = layout.get(node.id)!;
    node.position = { x: p.x - p.w / 2, y: p.y - p.h / 2 };
    node.data = { ...(node.data || {}), layoutWidth: p.w, layoutHeight: p.h };
  }

  // Fit distribution: expand only the whitespace (never the module bodies)
  // when the graph is smaller than the current canvas, then centre it. For a
  // graph larger than the canvas, retain the compact layout and anchor it with
  // a small margin so the minimum possible area remains visible.
  if (canvas && canvas.w > 0 && canvas.h > 0 && nodes.length) {
    const bounds = () => {
      const left = Math.min(...nodes.map(n => n.position.x));
      const top = Math.min(...nodes.map(n => n.position.y));
      const right = Math.max(...nodes.map(n => n.position.x + n.data.layoutWidth));
      const bottom = Math.max(...nodes.map(n => n.position.y + n.data.layoutHeight));
      return { left, top, right, bottom, w: right - left, h: bottom - top };
    };
    let b = bounds();
    const margin = 42;
    const availableW = Math.max(1, canvas.w - margin * 2);
    const availableH = Math.max(1, canvas.h - margin * 2);
    const minW = Math.max(...nodes.map(n => n.data.layoutWidth));
    const minH = Math.max(...nodes.map(n => n.data.layoutHeight));
    const spanX = Math.max(1, Math.max(...nodes.map(n => n.position.x)) - Math.min(...nodes.map(n => n.position.x)));
    const spanY = Math.max(1, Math.max(...nodes.map(n => n.position.y)) - Math.min(...nodes.map(n => n.position.y)));
    const scaleX = b.w < availableW ? Math.min(1.8, Math.max(1, (availableW - minW) / spanX)) : 1;
    const scaleY = b.h < availableH ? Math.min(1.8, Math.max(1, (availableH - minH) / spanY)) : 1;
    if (scaleX > 1 || scaleY > 1) {
      for (const node of nodes) {
        node.position.x = b.left + (node.position.x - b.left) * scaleX;
        node.position.y = b.top + (node.position.y - b.top) * scaleY;
      }
      b = bounds();
    }
    const dx = b.w <= availableW ? (canvas.w - b.w) / 2 - b.left : margin - b.left;
    const dy = b.h <= availableH ? (canvas.h - b.h) / 2 - b.top : margin - b.top;
    for (const node of nodes) {
      node.position.x += dx;
      node.position.y += dy;
    }
  }
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
  aero_table:  { label: '插值表 LUT', icon: 'LUT', color: '#0ea5e9' },
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
  'deadband', 'kinematic', 'aerosurface_scale', 'integrator',
  'scheduled_gain', 'angle', 'switch', 'waypoint_distance', 'waypoint_heading',
  // legacy aliases from older saved files
  'lag', 'filter', 'aerosurface',
]);

// ── Signal extraction ───────────────────────────────────────────────────────

export function extractOutputSignal(item: ChannelItem): string {
  if (typeof item.output === 'string' && item.output.trim()) return item.output.trim();
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
  // JSBSim tables keep independent variables as table attributes, rather than
  // nested <property> nodes. Expose them to the graph as editable inputs.
  if (expr.kind === 'table') {
    for (const key of ['var1', 'var2', 'var3']) {
      if (typeof expr[key] === 'string' && expr[key].trim()) {
        acc.push({ name: expr[key], __tableRef: expr, __tableKey: key });
      }
    }
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
  if (item.type === 'constant') return [];
  if ((item.type === 'function' || item.type === 'fcs_function' || item.type === 'aero_table') && item.expression) {
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
    if (k < inputs.length) {
      if (nd.__tableRef && nd.__tableKey) nd.__tableRef[nd.__tableKey] = inputs[k] || nd.name;
      else nd.name = inputs[k] || nd.name;
    }
    k++;
  }
  return expr;
}

// A direct table factor is a separate operation: the independent variable is
// looked up before its result reaches the product. Keep these nodes derived
// from the expression so saving still writes the original JSBSim function.
export function insertProductTables(nodes: any[], edges: any[], previousNodes: any[] = []): void {
  const previous = new Map(previousNodes.filter(n => n.data?.kind === 'tablePreview').map(n => [n.id, n]));
  for (const owner of nodes.filter(n => n.data?.kind === 'component')) {
    const expr = owner.data.expression as ExprNode | undefined;
    if (owner.data.expanded || expr?.kind !== 'product') continue;
    const references = collectPropertyNodes(expr);
    const hiddenInputIndices = new Set<number>();
    for (const [factorIndex, factor] of expr.children.entries()) {
      if (factor.kind !== 'table') continue;
      const table = factor as ExprTable;
      const inputIndices = references.flatMap((ref, index) => ref.__tableRef === factor ? [index] : []);
      if (!inputIndices.length) continue;
      const id = `${owner.id}/table-${factorIndex}`;
      const old = previous.get(id);
      nodes.push({
        id, type: 'signalBlock',
        position: old?.position || { x: owner.position.x - 150, y: owner.position.y },
        ...(old?.data?.manualSize ? { style: old.style, width: old.width, height: old.height } : {}),
        data: {
          kind: 'tablePreview', itemType: 'aero_table', ownerId: owner.id,
          factorIndex, inputIndices, inputs: inputIndices.map(index => owner.data.inputs[index]),
          expression: table, name: `${table.tableType} 插值表`,
          ...(old?.data?.manualSize ? { manualSize: old.data.manualSize } : {}),
        },
      });
      for (const [port, inputIndex] of inputIndices.entries()) {
        const edge = edges.find(e => e.target === owner.id && e.targetHandle === `in-${inputIndex}`);
        if (edge) {
          edge.id = `e-${edge.source}-${id}-${port}`;
          edge.target = id;
          edge.targetHandle = `in-${port}`;
        }
      }
      const first = inputIndices[0];
      inputIndices.slice(1).forEach(index => hiddenInputIndices.add(index));
      edges.push({
        id: `e-${id}-${owner.id}-${first}`, source: id, sourceHandle: 'out',
        target: owner.id, targetHandle: `in-${first}`, type: 'signal',
        data: { signal: owner.data.inputs[first], tableResult: true },
      });
    }
    owner.data = { ...owner.data, diagramInputIndices: owner.data.inputs.map((_: string, index: number) => index)
      .filter((index: number) => !hiddenInputIndices.has(index)) };
  }
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
    const isFn = e.item.type === 'function' || e.item.type === 'fcs_function' || e.item.type === 'aero_table';
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
        hasExplicitOutput: !!(e.item.output || e.item.componentProps?.output?.value),
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

  // ── Data-flow-driven layered layout ──
  // Use the global ranks and barycenter order calculated above. The old
  // channel-column layout discarded both and made large channels very tall.
  const NODE_W = 92;
  const NODE_H = 54;
  const COL_STEP = NODE_W + 150; // leave room for orthogonal routing tracks
  const ROW_STEP = NODE_H + 34;
  const START_X = 150;
  const START_Y = 80;
  const rankValues = [...byRank.keys()].sort((a, b) => a - b);
  const visualRank = new Map<number, number>();
  rankValues.forEach((r, i) => visualRank.set(r, i));
  const maxRows = Math.max(1, ...[...byRank.values()].map(ids => ids.length));
  const fullHeight = (maxRows - 1) * ROW_STEP;

  for (const r of rankValues) {
    const ids = byRank.get(r)!;
    const columnHeight = (ids.length - 1) * ROW_STEP;
    const y0 = START_Y + (fullHeight - columnHeight) / 2;
    ids.forEach((id, row) => {
      const n = nodes.find(nd => nd.id === id);
      if (n) n.position = {
        x: START_X + (visualRank.get(r) ?? 0) * COL_STEP,
        y: y0 + row * ROW_STEP,
      };
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
  const epGap = 130;
  // Place sources near the median of their consumers, then resolve collisions.
  const SOURCE_ROW = 34;
  const sourceEntries = [...sourceIds.entries()].map(([signal, id]) => {
    const ys = (consumersOf.get(signal) || [])
      .map(cid => nodes.find(n => n.id === cid)?.position.y)
      .filter((v): v is number => v !== undefined)
      .sort((a, b) => a - b);
    return { signal, id, idealY: ys.length ? ys[Math.floor(ys.length / 2)] : compMinY };
  }).sort((a, b) => a.idealY - b.idealY || a.signal.localeCompare(b.signal));
  let previousSourceY = compMinY - SOURCE_ROW;
  for (const entry of sourceEntries) {
    const n = nodes.find(x => x.id === entry.id)!;
    const y = Math.max(entry.idealY, previousSourceY + SOURCE_ROW);
    n.position = { x: compMinX - epGap, y };
    previousSourceY = y;
  }
  const sinkEntries = [...sinkIds.entries()].map(([signal, id]) => ({
    signal, id,
    idealY: nodes.find(n => n.id === producerOf.get(signal))?.position.y ?? compMinY,
  })).sort((a, b) => a.idealY - b.idealY || a.signal.localeCompare(b.signal));
  let previousSinkY = compMinY - SOURCE_ROW;
  for (const entry of sinkEntries) {
    const n = nodes.find(x => x.id === entry.id)!;
    const y = Math.max(entry.idealY, previousSinkY + SOURCE_ROW);
    n.position = { x: compMaxX + epGap, y };
    previousSinkY = y;
  }

  // Edges (wired by signal name)
  for (const e of items) {
    const inputs = consumerInputs.get(e.id)!;
    // Each occurrence is a distinct input port, even when the same property
    // is referenced twice. Routing may share the trunk, never omit a terminal.
    inputs.forEach((s, i) => {
      if (!s) return;
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

  insertProductTables(nodes, edges);

  // Dagre jointly optimises rank assignment, in-rank order and whitespace.
  // Run it after all endpoint nodes and edges exist, replacing the provisional
  // positions above with a compact, collision-free global layout.
  applyDagreSignalLayout(nodes, edges, opts.canvas);

  // ── Separate overlapping signal lines ──
  // Fan edges out from shared source/target handles by a small vertical offset
  // (visual only; the wiring/signal mapping is unchanged). Reduces the cases
  // where two wires run on top of each other.
  assignSignalEdgeRouting(edges, nodes, COL_STEP);

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
      const off = Math.max(-12, Math.min(12, (i - mid) * spread));
      e.data = e.data || {};
      e.data.srcOffset = off;
    });
  };
  const fanTgt = (list: any[]) => {
    const mid = (list.length - 1) / 2;
    list.forEach((e, i) => {
      const off = Math.max(-12, Math.min(12, (i - mid) * spread));
      e.data = e.data || {};
      e.data.tgtOffset = off;
    });
  };
  for (const l of bySrc.values()) fan(l);
  for (const l of byTgt.values()) fanTgt(l);
  return edges;
}

/**
 * Simulink-style fan-out routing. All edges leave a component through exactly
 * one output point and share the initial horizontal trunk. Their vertical
 * tracks are separated only inside the free corridor between node columns.
 */
export function assignSignalEdgeRouting(edges: any[], nodes: any[], colStep = 242): any[] {
  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const bySource = new Map<string, any[]>();
  for (const edge of edges) {
    const key = `${edge.source}:${edge.sourceHandle || 'out'}`;
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key)!.push(edge);
  }

  type SourceGroup = {
    list: any[]; sx: number; sy: number; direction: 1 | -1;
    boundaryX: number; targetMedianY: number; corridor: string;
  };
  const corridors = new Map<string, SourceGroup[]>();
  for (const list of bySource.values()) {
    const source = nodeById.get(list[0].source);
    const sx = source?.position.x ?? 0;
    const sy = source?.position.y ?? 0;
    const targets = list.map(e => nodeById.get(e.target)).filter(Boolean);
    const targetXs = targets.map(n => n.position.x as number);
    const rightward = targetXs.filter(x => x >= sx).length >= targetXs.length / 2;
    const direction: 1 | -1 = rightward ? 1 : -1;
    const inDirection = targetXs.filter(x => direction * (x - sx) > 0);
    const boundaryX = inDirection.length
      ? (direction > 0 ? Math.min(...inDirection) : Math.max(...inDirection))
      : sx + direction * colStep;
    const targetYs = targets.map(n => n.position.y as number).sort((a, b) => a - b);
    const targetMedianY = targetYs.length ? targetYs[Math.floor(targetYs.length / 2)] : sy;
    // Groups with the same source column, direction and first destination
    // column compete for tracks in the same physical routing corridor.
    const corridor = `${Math.round(sx)}:${direction}:${Math.round(boundaryX)}`;
    const group = { list, sx, sy, direction, boundaryX, targetMedianY, corridor };
    if (!corridors.has(corridor)) corridors.set(corridor, []);
    corridors.get(corridor)!.push(group);
  }

  for (const groups of corridors.values()) {
    groups.sort((a, b) => a.sy - b.sy || a.targetMedianY - b.targetMedianY ||
      a.list[0].source.localeCompare(b.list[0].source));
    groups.forEach((group, index) => {
      const locked = group.list.find(e => e.data?.routeLocked && typeof e.data?.routeX === 'number');
      const gap = Math.max(70, Math.abs(group.boundaryX - group.sx));
      // Keep clear of both node bodies. Every source gets a unique track;
      // only edges belonging to that same source are allowed to share it.
      const near = Math.min(74, Math.max(34, gap * 0.28));
      const far = Math.max(near, gap - 34);
      const fraction = (index + 1) / (groups.length + 1);
      const distance = near + (far - near) * fraction;
      const routeX = locked ? locked.data.routeX : group.sx + group.direction * distance;
      group.list.forEach((edge) => {
      edge.data = {
        ...(edge.data || {}),
        routeX,
        routeOffset: 0,
        // Never fan the source handle itself: one module has one output port.
        srcOffset: 0,
        tgtOffset: 0,
      };
      });
    });
  }
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
    else if (!channels[ch].name && name) channels[ch].name = name;
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
    if (d.itemType === 'function' || d.itemType === 'fcs_function' || d.itemType === 'aero_table') {
      const expr = cloneExpr(d.expression);
      setFunctionInputs(expr, inputs);
      item = { type: d.itemType, name: d.name || '', expression: expr };
      if (d.hasExplicitOutput && d.outputSignal) item.output = d.outputSignal;
      if (d.cliptoMin !== undefined) item.cliptoMin = d.cliptoMin;
      if (d.cliptoMax !== undefined) item.cliptoMax = d.cliptoMax;
    } else {
      const compProps = { ...(d.compProps || {}) };
      delete compProps.input;
      delete compProps.output;
      delete compProps.properties;
      delete compProps.gains;
      if (d.itemType === 'constant') {
        // A constant is a source: keep its value and output, but no input.
        delete compProps.inputs;
      } else if (SINGLE_INPUT_TYPES.has(d.itemType)) {
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
