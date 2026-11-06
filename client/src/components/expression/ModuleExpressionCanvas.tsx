import { useState, useCallback, useRef, useMemo, useEffect, Component, type ReactNode } from 'react';
import {
  ReactFlow, Background, Controls, MiniMap, SelectionMode,
  ReactFlowProvider, ConnectionMode,
  addEdge, type Node, type Edge, type Connection, type ReactFlowInstance,
  applyNodeChanges, applyEdgeChanges,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { ExprNode } from '../../types';
import {
  treeToGraph, graphToTree, createBlock, BLOCK_DEFS,
} from '../../utils/expressionConverter';
import {
  buildSignalGraph, graphToChannels, SINGLE_INPUT_TYPES, COMPONENT_META,
  assignSignalEdgeRouting, collectPropertyNodes, insertProductTables,
} from '../../utils/signalGraph';
import SignalEdge from './SignalEdge';
import { MonitorGraphProvider, useMonitorGraph, monitorNodeTypes, MonitorBranch, PlainSignalEdge } from '../monitor/MonitorGraph';
import { withSignalMonitor } from '../monitor/MonitoredEdge';
import { useSignalMonitorStore } from '../../store/signalMonitorStore';
import { addScopeInView } from '../monitor/scopePlacement';
import { SignalEdgeActionsContext } from './signalEdgeActions';
import type { Bendpoint } from '../edges/bendpoints';
import { layoutSignalGraph } from '../../utils/signalLayout';
import { routeSignalGraph } from '../../utils/signalRouting';
import { canvasLayoutNeedsRepair } from '../../utils/canvasLayoutIntegrity';
import { pendingOperatorIds } from './pendingOperators';
import FunctionBlockNode from './FunctionBlockNode';
import SignalBlockNode from './SignalBlockNode';
import SignalEndNode from './SignalEndNode';
import ExpressionPalette from './ExpressionPalette';
import { BlockPropertyPanel } from './BlockPropertyPanel';
import ComponentPropertyPanel from './ComponentPropertyPanel';
import ExpressionEditor from './ExpressionEditor';
import LutTablePreview from './LutTablePreview';
import FormulaNotebook from './FormulaNotebook';
import SignalPathInput from '../SignalPathInput';
import NodeContextMenu from '../NodeContextMenu';
import { moduleIsDisabled } from '../../utils/disabledXml';
import { disabledGraph } from '../../utils/disabledGraph';

const nodeTypes = {
  ...monitorNodeTypes,
  functionBlock: FunctionBlockNode,
  signalBlock: SignalBlockNode,
  signalEnd: SignalEndNode,
};

// Custom edge that fans out wires sharing a handle (see SignalEdge). Stable
// reference so ReactFlow doesn't warn about changing edgeTypes identity.
const MonitoredSignalEdge = withSignalMonitor(SignalEdge);
const MonitoredPlainEdge = withSignalMonitor(PlainSignalEdge);
const edgeTypes = { signal: MonitoredSignalEdge, smoothstep: MonitoredPlainEdge, monitorBranch: MonitorBranch };

export interface ModuleExpression {
  id: string;
  name: string;
  expression: ExprNode;
}

interface ModuleExpressionCanvasProps {
  expressions?: ModuleExpression[];
  onChange?: (id: string, expr: ExprNode) => void;
  channels?: any[];
  baselineChannels?: any[] | null;
  moduleDisabled?: boolean;
  allowChannelDisable?: boolean;
  topLevelProps?: string[];
  propertyDefinitions?: { name: string; attrs?: Record<string, string> }[];
  onPropertyValueChange?: (name: string, value: string) => void;
  onChannelsChange?: (channels: any[]) => void;
  onBack: () => void;
  title?: string;
  mode?: 'expr' | 'signal';
  /** When true, render filling its container (integrated into the main
   *  workspace) instead of as a full-screen modal overlay. */
  embedded?: boolean;
  /** Per-model identity + layout persistence. When provided, the canvas
   *  restores saved node positions on open and writes them back on change,
   *  so each model remembers its own tidy arrangement. */
  modelId?: string;
  initialLayout?: Record<string, { x: number; y: number }>;
  onLayoutChange?: (layout: Record<string, { x: number; y: number }>) => void;
  onInit?: (instance: ReactFlowInstance) => void;
  initialOpenComponentId?: string;
  findPropertySource?: (signal: string) => { label: string } | null;
  onOpenPropertySource?: (signal: string) => void;
}

function withInitialPropertyValues(nodes: Node[], definitions: ModuleExpressionCanvasProps['propertyDefinitions']): Node[] {
  const values = new Map((definitions || [])
    .filter(definition => definition?.name && definition.attrs?.value !== undefined)
    .map(definition => [definition.name, String(definition.attrs!.value)]));
  return nodes.map(node => {
    if (node.data?.kind !== 'signal' || node.data.signalRole !== 'source') return node;
    const initialValue = values.get(String(node.data.signalName || ''));
    return node.data.initialValue === initialValue ? node
      : { ...node, data: { ...node.data, initialValue } };
  });
}

function signalRoutingKey(nodes: Node[], edges: Edge[]) {
  return JSON.stringify([
    nodes.map(n => [n.id, n.hidden, n.position, n.measured, n.dragging, n.resizing,
      n.data?.inputs, n.data?.inputCount, n.data?.manualSize]),
    edges.map(e => [e.id, e.source, e.sourceHandle, e.target, e.targetHandle, e.hidden, e.data?.bendpoints]),
  ]);
}

function signalRoutingError(edges: Edge[]) {
  const blocked = edges.filter(edge => edge.data?.routingBlocked).length;
  return blocked ? `${blocked} 条连线空间不足，请移动相邻组件或调整手动折点；也可点击自动布局。` : '';
}

function InitialPropertyValue({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState('');
  useEffect(() => { setDraft(value); setError(''); }, [value]);

  const commit = () => {
    const next = draft.trim();
    if (!next || !Number.isFinite(Number(next))) {
      setError('请输入有效数字');
      return;
    }
    setError('');
    if (next !== value) onChange(next);
  };

  return <div className="signal-panel-field">
    <label htmlFor="signal-initial-value">初始值</label>
    <input id="signal-initial-value" type="text" inputMode="decimal" value={draft}
      onChange={event => { setDraft(event.target.value); setError(''); }}
      onBlur={commit}
      onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
    <small>模型加载时使用的数值。按 Enter 或离开输入框后应用。</small>
    {error && <p className="signal-panel-error" role="alert">{error}</p>}
  </div>;
}

// ── Merge multiple expression trees into one graph (expr mode) ───────────────
function buildMergedGraph(expressions: ModuleExpression[]) {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const rootIds: Record<string, string> = {};
  const propMerge = new Map<string, string>();
  let offsetX = 0;

  expressions.forEach((exprItem, i) => {
    if (!exprItem.expression || !exprItem.expression.kind) return;
    const sub = treeToGraph(exprItem.expression, exprItem.name);
    const prefix = `e${i}_`;
    const idMap = new Map<string, string>();
    let localMaxX = 0;

    for (const n of sub.nodes) {
      const globalId = prefix + n.id;
      const exprNodeAny = n.data?.exprNode as any;
      const isProp = exprNodeAny?.kind === 'property';
      const pname: string | undefined = isProp ? exprNodeAny?.name : undefined;
      if (isProp) {
        if (pname && propMerge.has(pname)) {
          idMap.set(n.id, propMerge.get(pname)!);
          continue;
        }
        if (pname) propMerge.set(pname, globalId);
      }
      idMap.set(n.id, globalId);

      const cloned: Node = {
        ...n,
        id: globalId,
        position: { x: n.position.x + offsetX, y: n.position.y },
        data: { ...n.data },
        selected: false,
      };
      if (n.id === sub.rootId) {
        (cloned.data as any).exprName = exprItem.name;
        (cloned.data as any).isExprRoot = true;
      }
      if (isProp && pname && propMerge.get(pname) === globalId) {
        (cloned.data as any).shared = true;
      }
      localMaxX = Math.max(localMaxX, n.position.x);
      nodes.push(cloned);
    }

    for (const e of sub.edges) {
      edges.push({
        ...e,
        id: prefix + e.id,
        source: idMap.get(e.source)!,
        target: idMap.get(e.target)!,
      });
    }

    rootIds[exprItem.id] = prefix + sub.rootId;
    offsetX = localMaxX + offsetX + 80;
  });

  return { nodes, edges, rootIds };
}

// ── Reconcile signal-flow endpoints + edges from node data (signal mode) ─────
// Single source of truth = component node data (name / inputs / compProps /
// expression). Edges and source/sink endpoint nodes are always derived.
// prevEdges lets in-canvas expression subgraphs (expanded functions) survive the
// rebuild: their internal edges are carried over and their block nodes are kept.
function recomputeGraph(nodes: any[], prevEdges: any[] = []): { nodes: any[]; edges: any[] } {
  const comps = nodes.filter(n => n.data?.kind === 'component').map(n => ({ ...n, data: { ...n.data } }));
  const exprNodes = nodes.filter(n => n.data?.kind === 'exprBlock');
  // Expanded function: ownerId -> subgraph root node; ownerId -> leaf (signal inlet) nodes.
  const expandedOf = new Map<string, any>();
  const leavesOf = new Map<string, any[]>();
  for (const n of exprNodes) {
    const owner = n.data.ownerId;
    const k = n.data.exprNode?.kind;
    if (k === 'property' || k === 'function_ref') {
      if (!leavesOf.has(owner)) leavesOf.set(owner, []);
      leavesOf.get(owner)!.push(n);
    }
  }
  for (const c of comps) {
    if (c.data.expanded && c.data.expRootId) {
      const root = exprNodes.find(n => n.id === c.data.expRootId);
      if (root) expandedOf.set(c.id, root);
    }
  }
  // A component's output wire comes from its subgraph root when expanded.
  const srcOf = (carrierId: string) =>
    expandedOf.has(carrierId)
      ? { node: expandedOf.get(carrierId).id, handle: 'out-0' }
      : { node: carrierId, handle: 'out' };

  const producers = new Map<string, string>();
  for (const c of comps) {
    const sig = c.data.outputSignal || c.data.name;
    if (sig && !producers.has(sig)) producers.set(sig, c.id);
  }
  const consumed = new Set<string>();
  for (const c of comps) for (const s of (c.data.inputs || [])) if (s) consumed.add(s);

  const neededSources = new Set<string>();
  for (const s of consumed) if (!producers.has(s)) neededSources.add(s);
  const neededSinks = new Set<string>();
  for (const [sig] of producers) if (!consumed.has(sig)) neededSinks.add(sig);

  const existing = new Map<string, any>();
  for (const n of nodes) if (n.data?.kind === 'signal') existing.set(n.id, n);

  let minX = Infinity, maxX = -Infinity, maxY = 0;
  for (const c of comps) {
    minX = Math.min(minX, c.position.x);
    maxX = Math.max(maxX, c.position.x);
    maxY = Math.max(maxY, c.position.y);
  }
  if (!isFinite(minX)) { minX = 0; maxX = 0; }

  // Per-signal consumer list (for lane-aligned endpoint placement).
  const consumersOfSig = new Map<string, string[]>();
  for (const c of comps) {
    for (const s of (c.data.inputs || [])) {
      if (!s) continue;
      if (!consumersOfSig.has(s)) consumersOfSig.set(s, []);
      consumersOfSig.get(s)!.push(c.id);
    }
  }

  // Endpoints aligned to the row of their connected component, so source/sink
  // leads stay attached to the right channel lane after edits.
  const compY = (id?: string) => (id ? (comps.find(c => c.id === id)?.position.y) : undefined);
  const endpoints: any[] = [];
  for (const s of neededSources) {
    const nid = `src-${s}`;
    if (existing.has(nid)) { endpoints.push(existing.get(nid)); continue; }
    const y = compY((consumersOfSig.get(s) || [])[0]) ?? maxY + 140;
    endpoints.push({ id: nid, type: 'signalEnd', position: { x: minX - 280, y }, data: { kind: 'signal', signalRole: 'source', signalName: s } });
  }
  for (const s of neededSinks) {
    const nid = `sink-${s}`;
    if (existing.has(nid)) { endpoints.push(existing.get(nid)); continue; }
    const y = compY(producers.get(s)) ?? maxY + 140;
    endpoints.push({ id: nid, type: 'signalEnd', position: { x: maxX + 280, y }, data: { kind: 'signal', signalRole: 'sink', signalName: s } });
  }

  const finalNodes = [...comps, ...exprNodes, ...endpoints];
  const edges: any[] = [];
  for (const c of comps) {
    if (expandedOf.has(c.id)) {
      // Expanded: one inlet wire per leaf, keyed by the leaf's property name.
      for (const leaf of (leavesOf.get(c.id) || [])) {
        const s = leaf.data.exprNode?.name; if (!s) continue;
        const prod = producers.get(s);
        const src = prod && prod !== c.id ? srcOf(prod) : { node: `src-${s}`, handle: 'out' };
        edges.push({ id: `e-${src.node}-${leaf.id}`, source: src.node, sourceHandle: src.handle, target: leaf.id, targetHandle: 'in-signal', label: s, data: { signal: s }, type: 'signal' });
      }
      continue;
    }
    // Preserve a terminal connection for every declared input occurrence.
    (c.data.inputs || []).forEach((s: string, i: number) => {
      // Repeated references still have separate ports; only their routed
      // trunk is shared. Keep every terminal when rebuilding the graph.
      if (!s) return;
      const prod = producers.get(s);
      const src = prod && prod !== c.id ? srcOf(prod) : { node: `src-${s}`, handle: 'out' };
      edges.push({ id: `e-${src.node}-${c.id}-${i}`, source: src.node, sourceHandle: src.handle, target: c.id, targetHandle: `in-${i}`, label: s, data: { signal: s }, type: 'signal' });
    });
  }
  for (const s of neededSinks) {
    const src = srcOf(producers.get(s)!);
    edges.push({ id: `e-${src.node}-sink-${s}`, source: src.node, sourceHandle: src.handle, target: `sink-${s}`, targetHandle: 'in', label: s, data: { signal: s }, type: 'signal' });
  }
  // Carry over in-canvas subgraph internal edges whose endpoints survived.
  const alive = new Set(finalNodes.map(n => n.id));
  for (const e of prevEdges) {
    if (e.data?.kind === 'expr-internal' && alive.has(e.source) && alive.has(e.target)) edges.push(e);
  }
  insertProductTables(finalNodes, edges, nodes);
  // Preserve signal-edge waypoints (bendpoints) across the rebuild, keyed by edge id.
  const prevBp = new Map<string, Bendpoint[]>();
  for (const e of prevEdges) {
    const b = e.data?.bendpoints;
    if (Array.isArray(b) && b.length) prevBp.set(e.id, b);
  }
  if (prevBp.size) {
    for (const e of edges) {
      const b = prevBp.get(e.id);
      if (b) e.data = { ...(e.data || {}), bendpoints: b };
    }
  }
  const previous = new Map(prevEdges.map(e => [e.id, e]));
  for (const e of edges) {
    const old = previous.get(e.id);
    if (old?.data?.elkRoute && old.sourceHandle === e.sourceHandle && old.targetHandle === e.targetHandle) {
      e.data = { ...e.data, elkRoute: old.data.elkRoute };
    }
  }
  // Recreate common fan-out trunks after edits/reloads as well as auto-layout.
  assignSignalEdgeRouting(edges, finalNodes);
  return { nodes: finalNodes, edges };
}

// ── Component palette for signal mode ───────────────────────────────────────
// Every FCS component defined in JSBSimCommon.xsd <channel>.
const COMPONENT_PALETTE = [
  'function', 'fcs_function', 'summer', 'pure_gain', 'pid', 'integrator',
  'scheduled_gain', 'bias', 'constant', 'difference', 'product', 'quotient',
  'pow', 'atan2', 'switch', 'actuator', 'aerosurface_scale', 'angle',
  'kinematic', 'deadband', 'lag_filter', 'lead_lag_filter',
  'second_order_filter', 'washout_filter', 'sensor', 'gyro',
  'accelerometer', 'magnetometer', 'waypoint_distance', 'waypoint_heading',
];

export default function ModuleExpressionCanvas(props: ModuleExpressionCanvasProps) {
  const {
    expressions = [], onChange, channels = [], topLevelProps = [],
    onChannelsChange, onBack, title, mode, embedded = false,
    initialLayout, onLayoutChange,
  } = props;
  const isSignal = mode === 'signal' || mode !== 'expr' && props.channels != null;
  const hasFormulaView = mode === 'signal' || props.channels != null;

  const initial = useMemo(() => {
    // Build identities/wiring immediately; measured, port-aware placement is
    // asynchronous below. A saved layout must never pay for a discarded Dagre
    // layout (especially with hundreds of operators).
    const g = isSignal ? buildSignalGraph(channels, topLevelProps, { layout: false }) : buildMergedGraph(expressions);
    if (isSignal) g.nodes = withInitialPropertyValues(g.nodes, props.propertyDefinitions);
    // Restore saved positions for this model, if any.
    if (initialLayout) {
      for (const n of g.nodes) {
        const p = initialLayout[n.id];
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) n.position = { x: p.x, y: p.y };
        const size = (initialLayout as any).__sizes?.[n.id];
        if (size && Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0) {
          n.data = { ...n.data, manualSize: size };
          n.style = { ...n.style, width: size.width, height: size.height };
          n.width = size.width;
          n.height = size.height;
        }
      }
      // Older saved layouts predate the derived LUT nodes. Place each new
      // table in its owner's existing input corridor instead of mixing old
      // component coordinates with the freshly calculated graph coordinates.
      for (const table of g.nodes.filter(n => n.data?.kind === 'tablePreview' && !initialLayout[n.id])) {
        const owner = g.nodes.find(n => n.id === table.data.ownerId);
        const incoming = g.edges.find(e => e.target === table.id);
        const source = g.nodes.find(n => n.id === incoming?.source);
        if (!owner) continue;
        const tableWidth = 88;
        const sourceRight = source ? source.position.x + (source.data?.kind === 'signal' ? 126 : 94) : owner.position.x - 180;
        table.position = {
          x: (sourceRight + owner.position.x - tableWidth) / 2,
          y: source && Math.abs(source.position.y - owner.position.y) < 80
            ? (source.position.y + owner.position.y) / 2 : owner.position.y,
        };
      }
      // Restore edge waypoints saved alongside the layout.
      const savedBps = (initialLayout as any).__bendpoints as Record<string, Bendpoint[]> | undefined;
      if (savedBps) {
        for (const e of g.edges) {
          const b = savedBps[e.id];
          if (b) e.data = { ...(e.data || {}), bendpoints: b };
        }
      }
      const savedRoutes = (initialLayout as any).__routes as Record<string, number> | undefined;
      if (savedRoutes) {
        for (const e of g.edges) {
          if (savedRoutes[e.id] !== undefined) {
            e.data = { ...(e.data || {}), routeX: savedRoutes[e.id] };
          }
        }
      }
      const elkRoutes = (initialLayout as any).__elkRoutes;
      for (const e of g.edges) {
        if (elkRoutes?.[e.id]) e.data = { ...e.data, elkRoute: elkRoutes[e.id] };
      }
    }
    return g;
  }, []); // build once on mount

  const [nodes, setNodes] = useState<Node[]>(initial.nodes);
  const [edges, setEdges] = useState<Edge[]>(initial.edges);
  const rootIdsRef = useRef<Record<string, string>>((initial as { rootIds?: Record<string, string> }).rootIds || {});
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const [disabledChanged, setDisabledChanged] = useState(false);
  // In-canvas function expansion (MVP: at most one function expanded at a time).
  const [expandedFnId, setExpandedFnId] = useState<string | null>(null);
  const rfWrapper = useRef<HTMLDivElement>(null);
  const rfInstance = useRef<ReactFlowInstance | null>(null);
  const [layoutBusy, setLayoutBusy] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [initializing, setInitializing] = useState(isSignal && initial.nodes.length > 0);
  const [routingBusy, setRoutingBusy] = useState(false);
  const [formulaView, setFormulaView] = useState(false);
  const [layoutError, setLayoutError] = useState('');
  const layoutRequest = useRef(0);
  const layoutAbort = useRef<AbortController | null>(null);
  const routingAbort = useRef<AbortController | null>(null);
  const lastRoutedKey = useRef('');
  const activeLayoutKey = useRef('');
  useEffect(() => () => {
    layoutRequest.current++;
    layoutAbort.current?.abort();
    routingAbort.current?.abort();
  }, []);

  const pendingIds = useMemo(() => props.baselineChannels === undefined ? new Set<string>() : pendingOperatorIds(nodes, props.baselineChannels), [nodes, props.baselineChannels]);
  const disabledView = useMemo(() => disabledGraph(nodes, edges, props.moduleDisabled), [nodes, edges, props.moduleDisabled]);
  const monitor = useMonitorGraph(props.modelId || props.title || 'module', disabledView.nodes, disabledView.edges);
  const displayedNodes = useMemo(() => monitor.nodes.map(node => pendingIds.has(node.id) ? { ...node, data: { ...node.data, pendingSync: true } } : node), [monitor.nodes, pendingIds]);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const sourceChannelsRef = useRef(channels);
  const committedChannelsRef = useRef(JSON.stringify(channels));
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);
  const propertyValuesKey = JSON.stringify(props.propertyDefinitions || []);
  useEffect(() => {
    setNodes(current => {
      const updated = withInitialPropertyValues(current, props.propertyDefinitions);
      if (updated.every((node, index) => node === current[index])) return current;
      nodesRef.current = updated;
      return updated;
    });
  }, [propertyValuesKey]);

  // Per-model layout persistence (optional).
  const onLayoutChangeRef = useRef(onLayoutChange);
  useEffect(() => { onLayoutChangeRef.current = onLayoutChange; }, [onLayoutChange]);

  function layoutFromNodes(ns: any[]): Record<string, { x: number; y: number }> {
    const layout: Record<string, { x: number; y: number }> = {};
    const sizes: Record<string, unknown> = {};
    for (const n of ns) {
      if (n.type === 'signalBlock' || n.type === 'functionBlock' || n.type === 'signalEnd') {
        layout[n.id] = { ...n.position };
        if (n.data?.manualSize) sizes[n.id] = n.data.manualSize;
      }
    }
    if (Object.keys(sizes).length) (layout as any).__sizes = sizes;
    return layout;
  }
  const persistLayout = useCallback(() => {
    if (!onLayoutChangeRef.current) return;
    const layout = layoutFromNodes(nodesRef.current);
    // Bundle signal-edge waypoints into the layout JSON (opaque to App.tsx).
    const bps: Record<string, Bendpoint[]> = {};
    for (const e of edgesRef.current) {
      const bp = e.data?.bendpoints as Bendpoint[] | undefined;
      if (bp && bp.length) bps[e.id] = bp;
    }
    if (Object.keys(bps).length) (layout as any).__bendpoints = bps;
    const routes: Record<string, number> = {};
    for (const e of edgesRef.current) {
      const routeX = e.data?.routeX;
      if (typeof routeX === 'number') routes[e.id] = routeX;
    }
    if (Object.keys(routes).length) (layout as any).__routes = routes;
    const elkRoutes: Record<string, unknown> = {};
    for (const e of edgesRef.current) {
      if (e.data?.elkRoute) elkRoutes[e.id] = e.data.elkRoute;
    }
    if (Object.keys(elkRoutes).length) (layout as any).__elkRoutes = elkRoutes;
    onLayoutChangeRef.current(layout);
  }, []);

  // ── Signal-mode commit (recompute edges + report channel changes) ──
  const commitSignal = useCallback((nextNodes: any[]) => {
    if (props.moduleDisabled) return;
    const { nodes: rn, edges: re } = recomputeGraph(nextNodes, edgesRef.current);
    const valuedNodes = withInitialPropertyValues(rn, props.propertyDefinitions);
    nodesRef.current = valuedNodes;
    edgesRef.current = re;
    setNodes(valuedNodes);
    setEdges(re);
    const ch = graphToChannels(valuedNodes, re, sourceChannelsRef.current);
    const serialized = JSON.stringify(ch);
    if (serialized !== committedChannelsRef.current) {
      committedChannelsRef.current = serialized;
      onChannelsChange?.(ch);
    }
    persistLayout();
  }, [onChannelsChange, persistLayout, propertyValuesKey, props.moduleDisabled]);

  const toggleDisabled = useCallback((id: string, channel = false) => {
    const target = nodesRef.current.find(node => node.id === id);
    if (!target || props.moduleDisabled || target.data?.kind !== 'component') return;
    if (!channel && target.data.channelDisabled) return;
    const field = channel ? 'channelDisabled' : 'disabled';
    const disabled = !target.data[field];
    const changed = nodesRef.current.map(node => node.id === id || channel && node.data?.kind === 'component' && node.data.ch === target.data.ch
      ? { ...node, data: { ...node.data, [field]: disabled } } : node);
    // Collapse any expanded owner before rebuilding the signal graph.
    const owners = new Set(changed.filter(node => node.data?.kind === 'component' && (node.id === id || channel && node.data.ch === target.data.ch)).map(node => node.id));
    const next = changed.filter(node => !owners.has(String(node.data?.ownerId)) || node.data?.kind !== 'exprBlock')
      .map(node => owners.has(node.id) ? { ...node, data: { ...node.data, expanded: false } } : node);
    if (expandedFnId && owners.has(expandedFnId)) setExpandedFnId(null);
    setEditingExprId(null); setLutPreviewId(null);
    setDisabledChanged(true);
    commitSignal(next);
  }, [commitSignal, expandedFnId, props.moduleDisabled]);

  // ── Signal-edge bendpoints (waypoints) ──
  // Write waypoints to edges state only (no recompute), so a drag isn't blown
  // away by recomputeGraph. persistLayout bundles them into the layout JSON.
  const updateEdgeBendpoints = useCallback((edgeId: string, bps: Bendpoint[]) => {
    setEdges(prev => {
      const next = prev.map(e => (e.id === edgeId ? { ...e, data: { ...(e.data || {}), elkRoute: undefined, bendpoints: bps } } : e));
      edgesRef.current = next;
      return next;
    });
  }, []);
  const updateFanoutRoute = useCallback((source: string, sourceHandle: string | null | undefined, routeX: number) => {
    setEdges(prev => {
      const next = prev.map(e => (e.source === source && e.sourceHandle === sourceHandle)
        ? { ...e, data: { ...(e.data || {}), routeX, routeLocked: true } }
        : e);
      edgesRef.current = next;
      return next;
    });
  }, []);
  const persistBendpoints = useCallback(() => {
    persistLayout();
  }, [persistLayout]);
  const signalEdgeActions = useMemo(() => ({ updateBendpoints: updateEdgeBendpoints, updateFanoutRoute, persistBendpoints }),
    [updateEdgeBendpoints, updateFanoutRoute, persistBendpoints]);

  // ── In-canvas function expansion (Simulink-style operator subgraph) ──
  // Collapse: rebuild the expression from the subgraph (source of truth) and
  // restore the single carrier block.
  const collapseFunction = useCallback((fnId: string) => {
    const carrier: any = nodesRef.current.find(n => n.id === fnId);
    if (!carrier?.data?.expanded) return;
    const subNodes = nodesRef.current.filter(n => n.data?.kind === 'exprBlock' && n.data?.ownerId === fnId);
    const subEdges = edgesRef.current.filter(e => e.data?.kind === 'expr-internal' && e.data?.ownerId === fnId);
    let expr = carrier.data.expression;
    let inputs = carrier.data.inputs;
    try {
      const t = graphToTree(subNodes, subEdges, carrier.data.expRootId);
      if (t && t.kind) {
        expr = t;
        inputs = collectPropertyNodes(t).map((n: any) => n.name).filter(Boolean);
      }
    } catch (e) { console.warn('[collapseFunction] graphToTree failed, keep cached expression', e); }
    const rootPos = subNodes.find(n => n.id === carrier.data.expRootId)?.position;
    const next = nodesRef.current
      .filter(n => !(n.data?.kind === 'exprBlock' && n.data?.ownerId === fnId))
      .map(n => n.id === fnId
        ? { ...n, hidden: false,
            position: rootPos ? { x: Math.round(rootPos.x), y: Math.round(rootPos.y) } : n.position,
            data: { ...n.data, expression: expr, inputs, expanded: false, expRootId: undefined } }
        : n);
    setExpandedFnId(null);
    commitSignal(next);
  }, [commitSignal]);

  // Expand: hide the carrier block and inline its expression as a functionBlock
  // subgraph rooted at the carrier's position.
  const toggleExpand = useCallback((fnId: string) => {
    const carrier: any = nodesRef.current.find(n => n.id === fnId);
    if (!carrier || carrier.data?.kind !== 'component') return;
    if (carrier.data.expanded) { collapseFunction(fnId); return; }
    const expr = carrier.data.expression;
    if (!expr || !expr.kind) return;
    if (expandedFnId && expandedFnId !== fnId) collapseFunction(expandedFnId);

    const sub = treeToGraph(expr, carrier.data.name);
    const pref = (id: string) => `${fnId}/exp/${id}`;
    const subNodes = sub.nodes.map(n => ({
      ...n,
      id: pref(n.id),
      data: { ...n.data, kind: 'exprBlock', ownerId: fnId, inSignalFlow: true },
    }));
    const subEdges = sub.edges.map(e => ({
      ...e, id: pref(e.id), source: pref(e.source), target: pref(e.target),
      data: { ...e.data, kind: 'expr-internal', ownerId: fnId },
    }));
    // Align the subgraph root to the carrier's position (root is the rightmost column).
    const rootOld = sub.nodes.find(n => n.id === sub.rootId)!.position;
    const dx = carrier.position.x - rootOld.x, dy = carrier.position.y - rootOld.y;
    for (const n of subNodes) n.position = { x: n.position.x + dx, y: n.position.y + dy };

    const next = nodesRef.current
      .map(n => n.id === fnId
        ? { ...n, hidden: true, data: { ...n.data, expanded: true, expRootId: pref(sub.rootId) } }
        : n)
      .concat(subNodes);
    edgesRef.current = [...edgesRef.current, ...subEdges];
    setExpandedFnId(fnId);
    commitSignal(next);
  }, [expandedFnId, commitSignal, collapseFunction]);

  // Re-sync an expanded subgraph back into its carrier's expression + inputs cache.
  const expSync = useCallback((ownerId: string) => {
    setTimeout(() => {
      const carrier: any = nodesRef.current.find(n => n.id === ownerId);
      if (!carrier?.data?.expanded) return;
      const subNodes = nodesRef.current.filter(n => n.data?.kind === 'exprBlock' && n.data?.ownerId === ownerId);
      const subEdges = edgesRef.current.filter(e => e.data?.kind === 'expr-internal' && e.data?.ownerId === ownerId);
      let expr: ExprNode | null = null;
      try { expr = graphToTree(subNodes, subEdges, carrier.data.expRootId); }
      catch (e) { console.warn('[expSync]', e); }
      if (!expr || !expr.kind) return;
      const inputs = collectPropertyNodes(expr).map((n: any) => n.name).filter(Boolean);
      const next = nodesRef.current.map(n => n.id === ownerId
        ? { ...n, data: { ...n.data, expression: expr, inputs } } : n);
      commitSignal(next);
    }, 0);
  }, [commitSignal]);

  // Update one operator block's expression inside an expanded subgraph.
  const handleExprBlockUpdate = useCallback((nodeId: string, updatedExpr: ExprNode) => {
    const node: any = nodesRef.current.find(n => n.id === nodeId);
    if (!node || node.data?.kind !== 'exprBlock') return;
    const ownerId = node.data.ownerId;
    const def = BLOCK_DEFS[updatedExpr.kind];
    const inputCount = def
      ? (def.inputCount === 'variable' ? ((updatedExpr as any).children?.length || 2) : def.inputCount)
      : node.data.inputCount;
    const next = nodesRef.current.map(n => n.id === nodeId
      ? { ...n, data: { ...n.data, exprNode: updatedExpr, blockDef: def || n.data.blockDef, inputCount } } : n);
    nodesRef.current = next; setNodes(next);
    expSync(ownerId);
  }, [expSync]);

  // Add a new operator block into the currently-expanded subgraph.
  const handleAddExprBlock = useCallback((kind: string) => {
    if (kind === 'scope') { addScopeInView(props.modelId || props.title || 'module', rfInstance.current, rfWrapper.current); return; }
    if (!expandedFnId) return;
    const newExpr = createBlock(kind);
    const def = BLOCK_DEFS[kind];
    if (!def) return;
    const id = `${expandedFnId}/exp/blk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const inputCount = def.inputCount === 'variable' ? 2 : def.inputCount;
    let position = { x: 300, y: 200 };
    if (rfInstance.current && rfWrapper.current) {
      const b = rfWrapper.current.getBoundingClientRect();
      position = rfInstance.current.screenToFlowPosition({ x: b.width / 2, y: b.height / 2 });
      position.x += (Math.random() - 0.5) * 80;
      position.y += (Math.random() - 0.5) * 80;
    }
    const newNode: any = {
      id, type: 'functionBlock', position,
      data: { kind: 'exprBlock', ownerId: expandedFnId, inSignalFlow: true, exprNode: newExpr, blockDef: def, inputCount, blockId: id },
    };
    const next = [...nodesRef.current, newNode];
    nodesRef.current = next; setNodes(next);
    expSync(expandedFnId);
  }, [expandedFnId, expSync]);

  const syncToTree = useCallback(() => {
    const currentNodes = nodesRef.current;
    const currentEdges = edgesRef.current;
    if (!currentNodes || currentNodes.length === 0) return;
    for (const [id, rootId] of Object.entries(rootIdsRef.current)) {
      try {
        const tree = graphToTree(currentNodes, currentEdges, rootId);
        if (tree && tree.kind) onChange?.(id, tree);
      } catch (e) {
        console.warn('[ModuleExpressionCanvas] syncToTree error:', e);
      }
    }
  }, [onChange]);

  // ── Expr-mode handlers ──
  const onNodesChange = useCallback((changes: any) => {
    if (changes.some((c: any) => c.type === 'position' || c.type === 'remove' || c.type === 'dimensions' && c.resizing)) {
      // Moving any obstacle invalidates the automatically routed paths.
      layoutRequest.current++;
      layoutAbort.current?.abort();
      routingAbort.current?.abort();
      setLayoutBusy(false);
      setPlacing(false);
      setEdges(es => {
        const next = es.map(e => e.data?.elkRoute ? { ...e, data: { ...e.data, elkRoute: undefined } } : e);
        edgesRef.current = next;
        return next;
      });
    }
    setNodes(ns => {
      const next = applyNodeChanges(changes, ns);
      nodesRef.current = next;
      return next;
    });
  }, []);
  const onNodeDragStop = useCallback((_: unknown, node: Node, draggedNodes: Node[] = []) => {
    if ([node, ...draggedNodes].every(item => item.type === 'monitorScope' || item.type === 'monitorTap')) return;
    if (isSignal) {
      setTimeout(() => commitSignal(nodesRef.current), 0);
    } else {
      setTimeout(syncToTree, 0);
      persistLayout();
    }
  }, [isSignal, commitSignal, syncToTree, persistLayout]);

  // Layout the current graph, so expanded functions and unsaved edits survive.
  const handleAutoLayout = useCallback(async () => {
    const instance = rfInstance.current;
    if (!instance) return;
    layoutAbort.current?.abort();
    routingAbort.current?.abort();
    const controller = new AbortController();
    layoutAbort.current = controller;
    const request = ++layoutRequest.current;
    const inputNodes = nodesRef.current;
    const inputEdges = edgesRef.current;
    setLayoutBusy(true);
    setPlacing(true);
    setLayoutError('');
    try {
      const bounds = rfWrapper.current;
      const placed = isSignal
        ? await layoutSignalGraph(inputNodes, inputEdges, instance.getInternalNode,
          bounds ? bounds.clientWidth / Math.max(1, bounds.clientHeight) : 1.6, controller.signal)
        : buildMergedGraph(expressions);
      if (request !== layoutRequest.current) return;
      // Publish complete measured placement immediately. Detailed obstacle
      // routing can take much longer on dense graphs and must not delay a
      // usable, fully connected canvas.
      if (nodesRef.current !== inputNodes || edgesRef.current !== inputEdges) {
        setLayoutError('画布已变化，请重新整理布局。');
        return;
      }
      nodesRef.current = placed.nodes;
      edgesRef.current = placed.edges;
      setNodes(placed.nodes);
      setEdges(placed.edges);
      setPlacing(false);
      setInitializing(false);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (request === layoutRequest.current) instance.fitView({ padding: 0.08, maxZoom: 1.4, duration: 300 });
      }));
      const placementKey = signalRoutingKey(placed.nodes, placed.edges);
      activeLayoutKey.current = placementKey;
      let routedEdges = placed.edges;
      let routingFailed = false;
      if (isSignal) {
        try {
          routedEdges = await routeSignalGraph(placed.nodes, placed.edges, instance.getInternalNode, controller.signal);
        } catch (error) {
          if (controller.signal.aborted) return;
          // ELK already produced a complete layout. Keep it on screen even
          // if optional path refinement fails or times out.
          routingFailed = true;
          console.warn('[signal routing]', error);
        }
      }
      if (request !== layoutRequest.current || signalRoutingKey(nodesRef.current, edgesRef.current) !== placementKey) return;
      const routes = new Map(routedEdges.map(edge => [edge.id, edge]));
      const currentEdges = edgesRef.current.map(edge => {
        const routed = routes.get(edge.id);
        return routed ? { ...edge, type: routed.type, data: { ...edge.data, ...routed.data } } : edge;
      });
      edgesRef.current = currentEdges;
      lastRoutedKey.current = signalRoutingKey(nodesRef.current, currentEdges);
      if (isSignal) setLayoutError(routingFailed ? '连线整理未完成，已显示全部连接，可点击自动布局重试。' : signalRoutingError(currentEdges));
      setEdges(currentEdges);
      persistLayout();
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error('[signal layout]', error);
      if (request === layoutRequest.current) setLayoutError('自动布局失败，已保留原布局，请重试。');
    } finally {
      if (request === layoutRequest.current) { setLayoutBusy(false); setPlacing(false); }
    }
  }, [isSignal, expressions, persistLayout]);

  // Reroute after moves, resizes, port edits and saved-layout restoration.
  // Positions remain user-controlled; only the paths are recomputed here.
  const routingKey = signalRoutingKey(nodes, edges);
  const latestRoutingKey = useRef(routingKey);
  latestRoutingKey.current = routingKey;
  useEffect(() => {
    if (layoutBusy && !placing && activeLayoutKey.current && activeLayoutKey.current !== routingKey) {
      layoutRequest.current++;
      layoutAbort.current?.abort();
      setLayoutBusy(false);
    }
  }, [routingKey, layoutBusy, placing]);
  useEffect(() => {
    if (!isSignal || layoutBusy || initializing || !nodes.length ||
      routingKey === lastRoutedKey.current || nodes.some(n => n.dragging || n.resizing)) {
      setRoutingBusy(false);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    routingAbort.current = controller;
    setRoutingBusy(true);
    const timer = setTimeout(async () => {
      const instance = rfInstance.current;
      if (!instance) { setRoutingBusy(false); return; }
      try {
        const routed = await routeSignalGraph(nodesRef.current, edgesRef.current, instance.getInternalNode, controller.signal);
        if (cancelled || controller.signal.aborted || latestRoutingKey.current !== routingKey) return;
        const byId = new Map(routed.map(e => [e.id, e]));
        const next = edgesRef.current.map(e => {
          const r = byId.get(e.id);
          return r ? { ...e, type: r.type, data: { ...e.data, ...r.data } } : e;
        });
        edgesRef.current = next;
        lastRoutedKey.current = routingKey;
        setEdges(next);
        setLayoutError(signalRoutingError(next));
        persistLayout();
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error('[signal routing]', error);
        if (!cancelled) setLayoutError('连线整理失败，请点击自动布局重试。');
      } finally {
        if (!cancelled) setRoutingBusy(false);
      }
    }, 100);
    return () => { cancelled = true; clearTimeout(timer); controller.abort(); };
  }, [routingKey, isSignal, layoutBusy, initializing, persistLayout]);

  // Check complete, measured geometry before accepting a saved layout. Never
  // persist provisional positions or route a partial/overlapping old layout.
  useEffect(() => {
    if (!isSignal || !initial.nodes.length) return;
    let frame: number;
    let cancelled = false;
    const arrangeWhenMeasured = () => {
      if (cancelled || !nodesRef.current.length) return;
      const instance = rfInstance.current;
      if (instance && nodesRef.current.filter(n => !n.hidden).every(n => instance.getInternalNode(n.id)?.measured?.width)) {
        if (canvasLayoutNeedsRepair(nodesRef.current, initialLayout, instance.getInternalNode)) {
          void handleAutoLayout().finally(() => { if (!cancelled) setInitializing(false); });
        } else setInitializing(false);
      } else frame = requestAnimationFrame(arrangeWhenMeasured);
    };
    frame = requestAnimationFrame(arrangeWhenMeasured);
    return () => { cancelled = true; cancelAnimationFrame(frame); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onEdgesChange = useCallback((changes: any) => {
    setEdges(es => applyEdgeChanges(changes, es));
  }, []);
  const onConnect = useCallback((connection: Connection) => {
    if (props.moduleDisabled || [connection.source, connection.target].some(id => {
      const node = nodesRef.current.find(item => item.id === id);
      return moduleIsDisabled(node?.data) || moduleIsDisabled(nodesRef.current.find(owner => owner.id === node?.data.ownerId)?.data);
    })) return;
    if (isSignal) {
      const src: any = nodesRef.current.find(n => n.id === connection.source);
      const tgt: any = nodesRef.current.find(n => n.id === connection.target);
      if (!src || !tgt) return;
      // The visible LUT is derived from the function expression. Reconnecting
      // an axis edits that expression's independent variable, then rebuilds
      // the derived node and its wires.
      if (tgt.data?.kind === 'tablePreview') {
        const port = Number(String(connection.targetHandle).replace('in-', ''));
        const index = tgt.data.inputIndices?.[port];
        const signal = src.data?.kind === 'component'
          ? src.data.outputSignal || src.data.name : src.data?.signalName;
        if (!Number.isInteger(index) || !signal) return;
        const next = nodesRef.current.map(n => {
          if (n.id !== tgt.data.ownerId) return n;
          const expression = structuredClone(n.data.expression);
          const ref = collectPropertyNodes(expression)[index];
          if (!ref?.__tableRef) return n;
          ref.__tableRef[ref.__tableKey] = signal;
          const inputs = [...((n.data.inputs as string[]) || [])];
          inputs[index] = signal;
          return { ...n, data: { ...n.data, expression, inputs } };
        });
        commitSignal(next);
        return;
      }
      const srcExp = src.data?.kind === 'exprBlock';
      const tgtExp = tgt.data?.kind === 'exprBlock';

      // (a) external signal -> subgraph leaf inlet: retarget the leaf's input.
      if (!srcExp && tgtExp && connection.targetHandle === 'in-signal') {
        const outSig = src.data?.kind === 'component'
          ? (src.data.outputSignal || src.data.name) : src.data?.signalName;
        if (!outSig) return;
        const ownerId = tgt.data.ownerId;
        const next = nodesRef.current.map(n => n.id === tgt.id
          ? { ...n, data: { ...n.data, exprNode: { ...(n.data.exprNode as any), name: outSig } } } : n);
        nodesRef.current = next; setNodes(next);
        expSync(ownerId);
        return;
      }
      // (b) internal subgraph wire: same owner, in-<n> port only.
      if (srcExp && tgtExp) {
        if (src.data.ownerId !== tgt.data.ownerId || !/^in-\d+$/.test(String(connection.targetHandle))) return;
        const ownerId = src.data.ownerId;
        const e = { ...connection, id: `${ownerId}/exp/e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'smoothstep', data: { kind: 'expr-internal', ownerId } };
        edgesRef.current = [...edgesRef.current, e]; setEdges(edgesRef.current);
        expSync(ownerId);
        return;
      }
      // (c) subgraph root -> external component: retarget that component's input
      // to this function's output signal.
      if (srcExp && !tgtExp) {
        const carrier: any = nodesRef.current.find(n => n.id === src.data.ownerId);
        if (!carrier || src.id !== carrier.data.expRootId || tgt.data?.kind !== 'component') return;
        const outSig = carrier.data.outputSignal || carrier.data.name;
        const idx = parseInt(String(connection.targetHandle).replace('in-', ''), 10);
        if (isNaN(idx) || !outSig) return;
        const next = nodesRef.current.map(n => {
          if (n.id !== tgt.id) return n;
          const inputs = [...((n.data.inputs as any) || [])];
          const oldSig = inputs[idx]; inputs[idx] = outSig; for (let j = 0; j < inputs.length; j++) { if (j !== idx && inputs[j] === oldSig) inputs[j] = outSig; }
          return { ...n, data: { ...n.data, inputs } };
        });
        commitSignal(next);
        return;
      }
      // (d) component -> component (existing behaviour).
      if (tgt.data?.kind !== 'component') return;
      const outSig = src.data?.kind === 'component'
        ? (src.data.outputSignal || src.data.name)
        : src.data?.signalName;
      const idx = parseInt(String(connection.targetHandle).replace('in-', ''), 10);
      if (isNaN(idx) || !outSig) return;
      const next = nodesRef.current.map(n => {
        if (n.id !== tgt.id) return n;
        const inputs = [...((n.data.inputs as any) || [])];
        const oldSig = inputs[idx]; inputs[idx] = outSig; for (let j = 0; j < inputs.length; j++) { if (j !== idx && inputs[j] === oldSig) inputs[j] = outSig; }
        return { ...n, data: { ...n.data, inputs } };
      });
      commitSignal(next);
      return;
    }
    setEdges(es => addEdge({ ...connection, type: 'smoothstep', animated: false }, es));
    setTimeout(syncToTree, 0);
  }, [isSignal, commitSignal, syncToTree, expSync, props.moduleDisabled]);

  const onNodeClick = useCallback((e: any, node: Node) => {
    // Expand/collapse a function block via its ⤢ button (event delegation).
    const el = (e.target as HTMLElement)?.closest?.('[data-expand-toggle]');
    if (el && node.data?.kind === 'component' &&
        (node.data.itemType === 'function' || node.data.itemType === 'fcs_function')) {
      toggleExpand(node.id);
      return;
    }
    setSelectedNodeId(node.id);
  }, [toggleExpand]);

  // Double-click a LUT to inspect its breakpoint grid; other functions open
  // the formula editor as before.
  const onNodeDoubleClick = useCallback((_: any, node: Node) => {
    if (props.moduleDisabled || moduleIsDisabled(node.data)) { setSelectedNodeId(node.id); return; }
    const d = node.data;
    if (d?.kind === 'tablePreview') {
      setSelectedNodeId(node.id);
      setLutPreviewId(node.id);
      return;
    }
    if (d?.kind === 'component' && d.itemType === 'aero_table') {
      setSelectedNodeId(node.id);
      setLutPreviewId(node.id);
      return;
    }
    if (d?.kind === 'component' && (d.itemType === 'function' || d.itemType === 'fcs_function')) {
      setSelectedNodeId(node.id);
      setEditingExprId(node.id);
    }
  }, [props.moduleDisabled]);
  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, []);

  // ── Signal-mode: update a component node's data ──
  const updateComponent = useCallback((id: string, patch: any) => {
    if (props.moduleDisabled || moduleIsDisabled(nodesRef.current.find(node => node.id === id)?.data)) return;
    const next = nodesRef.current.map(n => {
      if (n.id !== id) return n;
      return { ...n, data: { ...n.data, ...patch } };
    });
    commitSignal(next);
  }, [commitSignal, props.moduleDisabled]);

  // ── Function expression editing (signal mode) ──
  const [editingExprId, setEditingExprId] = useState<string | null>(null);
  const [lutPreviewId, setLutPreviewId] = useState<string | null>(null);
  const editingNode = nodes.find(n => n.id === editingExprId);
  const lutPreviewNode = nodes.find(n => n.id === lutPreviewId);
  useEffect(() => {
    const id = props.initialOpenComponentId;
    if (!id) return;
    const target = nodesRef.current.find(n => n.id === id);
    if (target?.data?.kind === 'component' &&
        (target.data.itemType === 'function' || target.data.itemType === 'fcs_function')) {
      setSelectedNodeId(id);
      setEditingExprId(id);
    }
  }, [props.initialOpenComponentId]);
  const handleExprSave = useCallback((expr: ExprNode) => {
    if (editingExprId) updateComponent(editingExprId, { expression: expr });
    setEditingExprId(null);
  }, [editingExprId, updateComponent]);

  // ── Add / delete components (signal mode) ──
  const handleAddComponent = useCallback((type: string, dropPosition?: { x: number; y: number }) => {
    if (props.moduleDisabled) return;
    if (type === 'scope') { addScopeInView(props.modelId || props.title || 'module', rfInstance.current, rfWrapper.current, dropPosition); return; }
    const meta = COMPONENT_META[type] || { label: type, icon: '•', color: '#64748b' };
    const id = `c-new-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const inputs = type === 'constant' ? [] : SINGLE_INPUT_TYPES.has(type) ? [''] : ['', ''];
    const compProps: any = {};
    const channel = nodesRef.current.find(node => node.data?.kind === 'component' && node.data.ch === 0)?.data;
    // A constant needs both a value and an output property before it can be
    // represented in JSBSim XML. Give a new block a usable, unique draft.
    let name = '';
    if (type === 'constant') {
      const names = new Set(nodesRef.current.map(node => String((node.data as any)?.name || '')));
      let index = 1;
      while (names.has(`fcs/constant-${index}`)) index++;
      name = `fcs/constant-${index}`;
      compProps.constant = { value: '0', attrs: {} };
    }
    if (type === 'pure_gain') compProps.gain = { value: '1', attrs: {} };
    if (type === 'pid') { compProps.kp = { value: '1', attrs: {} }; compProps.ki = { value: '0', attrs: {} }; compProps.kd = { value: '0', attrs: {} }; }
    let position = dropPosition || { x: 400, y: 200 };
    if (!dropPosition && rfInstance.current && rfWrapper.current) {
      const b = rfWrapper.current.getBoundingClientRect();
      const p = rfInstance.current.screenToFlowPosition({ x: b.width / 2, y: b.height / 2 });
      position = { x: p.x + (Math.random() - 0.5) * 60, y: p.y + (Math.random() - 0.5) * 60 };
    }
    const newNode: any = {
      id, type: 'signalBlock', position,
      data: {
        kind: 'component', itemType: type, name, outputSignal: name,
        inputs, expression: type === 'function' ? { kind: 'value', value: 0 } : undefined,
        compProps, ch: 0,
        channelDisabled: !!channel?.channelDisabled, channelAttrs: channel?.channelAttrs,
        chName: String(channel?.chName || ''),
        itemIdx: 0, meta,
      },
    };
    commitSignal([...nodesRef.current, newNode]);
    setSelectedNodeId(id);
  }, [commitSignal]);

  const createFormula = useCallback((name: string, expression: ExprNode) => {
    if (props.moduleDisabled) return;
    const id = `c-formula-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const existing = nodesRef.current.find(node => node.data?.kind === 'component' &&
      (node.data as any).chName === '__JSBSIM_SYSTEM_TOP_LEVEL_FUNCTIONS__') ||
      nodesRef.current.find(node => node.data?.kind === 'component' &&
        ['function', 'fcs_function'].includes(String((node.data as any).itemType))) ||
      nodesRef.current.find(node => node.data?.kind === 'component');
    const ch = Number((existing?.data as any)?.ch ?? 0);
    const chName = String((existing?.data as any)?.chName ?? '');
    const node: Node = {
      id, type: 'signalBlock', position: { x: 400, y: 180 + nodesRef.current.length * 16 },
      data: { kind: 'component', itemType: 'function', name, outputSignal: name,
        inputs: collectPropertyNodes(expression).map(property => property.name), expression, compProps: {}, ch, chName, itemIdx: 0,
        meta: COMPONENT_META.function, channelDisabled: !!existing?.data.channelDisabled, channelAttrs: existing?.data.channelAttrs },
    };
    commitSignal([...nodesRef.current, node]);
    setSelectedNodeId(id);
  }, [commitSignal]);

  const handleDelete = useCallback(() => {
    if (props.moduleDisabled) return;
    if (selectedNodeId && useSignalMonitorStore.getState().project.scopes.some(scope => scope.id === selectedNodeId)) { useSignalMonitorStore.getState().removeScope(selectedNodeId); setSelectedNodeId(null); return; }
    if (!selectedNodeId) return;
    const sel: any = nodesRef.current.find(n => n.id === selectedNodeId);
    if (!sel) return;
    if (sel.data?.kind === 'tablePreview') return;
    // Deleting an expanded function carrier: cascade to its subgraph.
    if (sel.data?.kind === 'component') {
      const ownerId = sel.id;
      const next = nodesRef.current.filter(n => n.id !== ownerId && !(n.data?.kind === 'exprBlock' && n.data?.ownerId === ownerId));
      edgesRef.current = edgesRef.current.filter(e => !(e.data?.kind === 'expr-internal' && e.data?.ownerId === ownerId));
      if (expandedFnId === ownerId) setExpandedFnId(null);
      commitSignal(next);
      setSelectedNodeId(null);
      return;
    }
    // Deleting a node inside an expanded subgraph (root is protected).
    if (sel.data?.kind === 'exprBlock') {
      const ownerId = sel.data.ownerId;
      const carrier: any = nodesRef.current.find(n => n.id === ownerId);
      if (carrier && sel.id === carrier.data.expRootId) return;
      const next = nodesRef.current.filter(n => n.id !== selectedNodeId);
      nodesRef.current = next; setNodes(next);
      edgesRef.current = edgesRef.current.filter(e => !(e.data?.kind === 'expr-internal' && e.data?.ownerId === ownerId && (e.source === selectedNodeId || e.target === selectedNodeId)));
      setEdges(edgesRef.current);
      setSelectedNodeId(null);
      expSync(ownerId);
      return;
    }
    // Fallback: signal endpoint or other node — existing behaviour.
    const next = nodesRef.current.filter(n => n.id !== selectedNodeId);
    commitSignal(next);
    setSelectedNodeId(null);
  }, [selectedNodeId, commitSignal, expandedFnId, expSync, props.moduleDisabled]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
      if (!selectedNodeId) return;
      event.preventDefault();
      handleDelete();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedNodeId, handleDelete]);

  // ── Expr-mode add/edit (kept for aero / propulsion tables) ──
  const handleAddBlock = useCallback((kind: string) => {
    if (kind === 'scope') { addScopeInView(props.modelId || props.title || 'module', rfInstance.current, rfWrapper.current); return; }
    const newExpr = createBlock(kind);
    const def = BLOCK_DEFS[kind];
    if (!def) return;
    const id = `blk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const inputCount = def.inputCount === 'variable' ? 2 : def.inputCount;
    let position = { x: 300, y: 200 };
    if (rfInstance.current && rfWrapper.current) {
      const b = rfWrapper.current.getBoundingClientRect();
      position = rfInstance.current.screenToFlowPosition({ x: b.width / 2, y: b.height / 2 });
      position.x += (Math.random() - 0.5) * 80;
      position.y += (Math.random() - 0.5) * 80;
    }
    setNodes(ns => [...ns, { id, type: 'functionBlock', position, data: { exprNode: newExpr, blockDef: def, inputCount, blockId: id } }]);
    setSelectedNodeId(id);
    setTimeout(syncToTree, 0);
  }, [syncToTree]);

  const handleExprUpdateNode = useCallback((updatedExpr: ExprNode) => {
    if (!selectedNodeId) return;
    try {
      setNodes(ns => ns.map(n => {
        if (n.id !== selectedNodeId) return n;
        const def = BLOCK_DEFS[updatedExpr.kind];
        const inputCount = def ? (def.inputCount === 'variable' ? (updatedExpr as any).children?.length || 2 : def.inputCount) : 0;
        return { ...n, data: { ...n.data, exprNode: updatedExpr, blockDef: def || n.data.blockDef, inputCount } };
      }));
      setTimeout(syncToTree, 0);
    } catch (e) { console.warn('[ModuleExpressionCanvas] updateNode error:', e); }
  }, [selectedNodeId, syncToTree]);

  const handleBack = useCallback(() => {
    if (isSignal) commitSignal(nodesRef.current);
    else syncToTree();
    onBack();
  }, [isSignal, commitSignal, syncToTree, onBack]);

  const handleFitView = useCallback(() => {
    if (rfInstance.current) rfInstance.current.fitView({ padding: 0.08, maxZoom: 1.4, duration: 300 });
  }, []);

  const selectedNode = nodes.find(n => n.id === selectedNodeId);
  const contextTarget = nodes.find(node => node.id === contextMenu?.id);
  const contextOwner = contextTarget?.data?.kind === 'component' ? contextTarget
    : nodes.find(node => node.id === contextTarget?.data?.ownerId);
  const selectedDisabled = !!selectedNode && moduleIsDisabled(disabledView.nodes.find(node => node.id === selectedNode.id)?.data);
  const disabledSignals = selectedNode ? disabledView.edges.filter(edge => edge.source === selectedNode.id && edge.data?.moduleDisabled &&
    !moduleIsDisabled(disabledView.nodes.find(node => node.id === edge.target)?.data)).map(edge => String(edge.data?.signal || edge.label || '')).filter(Boolean) : [];
  const missingInputs = disabledView.nodes.find(node => node.id === selectedNodeId)?.data.disabledInputs as string[] | undefined;
  const selectedExpr = selectedNode?.data?.exprNode as ExprNode | undefined;
  const selectedIsRoot = !!(selectedNode?.data as any)?.isExprRoot;
  const hasExprs = !isSignal && expressions.some(e => e.expression && e.expression.kind);

  const editorInner = (
    <>
      <div className="expr-editor-topbar">
        <button className="expr-back-btn" onClick={handleBack}>{embedded ? '← 返回主模型' : '← 返回'}</button>
        <span className="expr-editor-title">
          {embedded
            ? `🛩️ 主模型 › ${isSignal ? (title || '模块信号流') : (title || '模块表达式')}`
            : `${isSignal ? '🔗 模块信号流画布 (Simulink 风格)' : '📐 模块表达式画布 (Simulink 风格)'}${title ? ` — ${title}` : ''}`}
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          {hasFormulaView && <button className={`formula-view-toggle${formulaView ? ' active' : ''}`}
            onClick={() => setFormulaView(value => !value)}
            aria-pressed={formulaView} title={formulaView ? '返回原信号画布' : '查看多行公式'}>
            {formulaView ? '▦ 返回画布' : '✎ 多行公式'}
          </button>}
          {(routingBusy || initializing && !layoutBusy) && <span role="status" style={{ alignSelf: 'center', color: '#64748b', fontSize: 11 }}>{initializing ? '加载画布…' : '整理连线…'}</span>}
          {!formulaView && <button className="expr-layout-btn" onClick={handleAutoLayout} disabled={layoutBusy} title="紧凑排列模块，按端口整理直角连线">{layoutBusy ? '整理中…' : '⤢ 自动布局'}</button>}
          {!formulaView && <button className="expr-fit-btn" onClick={handleFitView} title="适应视图">⊞ 居中</button>}
          <button className="expr-apply-btn" onClick={handleBack}>✓ 完成</button>
        </div>
      </div>

      {layoutError && <div role="status" style={{ padding: '6px 12px', color: '#b45309' }}>{layoutError}</div>}
      {(disabledChanged || props.moduleDisabled) && <div className="module-structure-notice" role="status">
        {props.moduleDisabled ? '所属模块已注释，内部为只读状态。返回主模型可取消注释。' : '注释和取消注释属于结构修改；保存到仿真机并重新加载模型后生效。'}
      </div>}

      {isSignal && expandedFnId && (
        <div className="expr-subgraph-bar">
          🧩 正在就地编辑&nbsp;<b>{(nodes.find(n => n.id === expandedFnId)?.data as any)?.name || expandedFnId}</b>&nbsp;的运算子图
          <button className="expr-subgraph-collapse-btn" onClick={() => collapseFunction(expandedFnId)}>⊟ 折叠</button>
        </div>
      )}

      {!isSignal && !hasExprs ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, color: '#888' }}>
          该模块没有可编辑的公式
        </div>
      ) : (
      <div className={`expr-editor-main${hasFormulaView && formulaView ? ' expr-editor-main--formula' : ''}`}>
        {props.moduleDisabled ? null : isSignal ? (
          expandedFnId ? (
            <ExpressionPalette onAddBlock={handleAddExprBlock} />
          ) : (
            <SignalPalette onAdd={handleAddComponent} />
          )
        ) : (
          <ExpressionPalette onAddBlock={handleAddBlock} />
        )}

        <div
          className="expr-canvas-wrapper"
          ref={rfWrapper}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
          onDrop={(e) => {
            const type = e.dataTransfer.getData('application/signal-component');
            if (!type || !rfInstance.current) return;
            e.preventDefault();
            handleAddComponent(type, rfInstance.current.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
          }}
        >
          <MonitorGraphProvider value={monitor.context}><SignalEdgeActionsContext.Provider value={signalEdgeActions}>
          <ReactFlow
            nodes={displayedNodes}
            edges={monitor.edges}
            onNodesChange={changes => { const modelChanges = monitor.filterChanges(changes); if (modelChanges.length) onNodesChange(modelChanges); }}
            onEdgesChange={onEdgesChange}
            onConnect={connection => { if (!monitor.connect(connection)) onConnect(connection); }}
            onNodeDragStop={onNodeDragStop}
            nodeTypes={nodeTypes}
            onInit={(instance) => { rfInstance.current = instance; props.onInit?.(instance); }}
            onNodeClick={(event, node) => {
              if (props.moduleDisabled || moduleIsDisabled(node.data)) { setSelectedNodeId(node.id); return; }
              onNodeClick(event, node);
            }}
            onNodeContextMenu={(event, node) => {
              event.preventDefault(); event.stopPropagation();
              setSelectedNodeId(node.id);
              setContextMenu({ x: event.clientX, y: event.clientY, id: node.id });
            }}
            onNodeDoubleClick={onNodeDoubleClick}
            onPaneClick={onPaneClick}
            fitView
            fitViewOptions={{ padding: 0.08, maxZoom: 1.4 }}
            minZoom={0.05}
            deleteKeyCode={null}
            snapToGrid
            snapGrid={[20, 20]}
            nodesDraggable={!placing && !initializing}
            nodesConnectable={!placing && !initializing && !props.moduleDisabled}
            elementsSelectable
            connectionMode={ConnectionMode.Loose}
            edgeTypes={edgeTypes}
            selectionOnDrag
            panOnDrag={[1, 2]}
            multiSelectionKeyCode="Shift"
            selectionMode={SelectionMode.Partial}
            onPaneContextMenu={(e) => e.preventDefault()}
          >
            <Background gap={20} size={1} />
            <Controls />
            <MiniMap />
          </ReactFlow>
          </SignalEdgeActionsContext.Provider></MonitorGraphProvider>
        </div>

        <div className="expr-props">
          {(disabledSignals.length > 0 || !!missingInputs?.length) && <div role="status" className="module-dependency-notice">
            <strong>{disabledSignals.length ? '下游仍引用此模块输出' : '输入来自已注释模块'}</strong>
            {[...new Set(disabledSignals.length ? disabledSignals : missingInputs)].map(signal => <code key={signal}>{signal}</code>)}
          </div>}
          {selectedDisabled ? <div className="module-disabled-panel">
            <span className="module-status-badge">已注释 · 不参与计算</span>
            {selectedNode?.data.kind === 'component' ? <fieldset disabled className="module-readonly-fields">
              <ComponentPropertyPanel data={selectedNode.data} onChange={() => {}} onDelete={() => {}} />
            </fieldset> : <p>{String(selectedNode?.data.name || selectedNode?.data.itemType || '模块')}</p>}
            <p>位置、参数与连线已保留。</p>
            <p>保存并重新加载模型后生效。</p>
            <button className="module-enable-button" disabled={props.moduleDisabled} onClick={() => selectedNode && toggleDisabled(selectedNode.id, !!selectedNode.data.channelDisabled)}>
              {selectedNode?.data.channelDisabled ? '取消所在通道注释' : '取消注释（启用）'}
            </button>
          </div> : editingExprId && editingNode ? (
            <ExpressionEditor
              expression={(editingNode.data as any).expression as ExprNode}
              baselineExpression={props.baselineChannels === undefined ? undefined : (props.baselineChannels ? (buildSignalGraph(props.baselineChannels).nodes.find(n => n.id === editingNode.id)?.data.expression as ExprNode | undefined) || null : null)}
              monitorOwner={String(editingNode.data.name || '')}
              onChange={handleExprSave}
              onLiveChange={expr => updateComponent(editingNode.id, { expression: expr })}
              onBack={() => setEditingExprId(null)}
              propertySource={(() => {
                const expr = (editingNode.data as any).expression as ExprNode;
                if (expr?.kind !== 'property') return null;
                const source = props.findPropertySource?.(expr.name);
                return source ? { signal: expr.name, label: source.label } : null;
              })()}
              onOpenPropertySource={props.onOpenPropertySource}
            />
          ) : selectedNode && (selectedNode.data as any)?.kind === 'exprBlock' ? (
            <BlockPropertyPanel
              expr={(selectedNode.data as any).exprNode as ExprNode}
              onChange={(updatedExpr: ExprNode) => handleExprBlockUpdate(selectedNode.id, updatedExpr)}
              onDelete={handleDelete}
              isRoot={selectedNode.id === ((nodes.find(n => n.id === (selectedNode.data as any).ownerId)?.data as any)?.expRootId)}
            />
          ) : selectedNode && (selectedNode.data as any)?.kind === 'component' ? (
            <ComponentPropertyPanel
              data={selectedNode.data as any}
              onChange={(patch) => updateComponent(selectedNode.id, patch)}
              onDelete={handleDelete}
              onEditExpression={((selectedNode.data as any).itemType === 'function' || (selectedNode.data as any).itemType === 'fcs_function')
                ? () => setEditingExprId(selectedNode.id) : (selectedNode.data as any).itemType === 'aero_table'
                  ? () => setLutPreviewId(selectedNode.id) : undefined}
            />
          ) : selectedNode && (selectedNode.data as any)?.kind === 'tablePreview' ? (
            <div className="expr-props-empty">
              <p>{String((selectedNode.data as any).expression?.tableType || '')} 插值表</p>
              <p className="expr-props-hint">输入：{((selectedNode.data as any).inputs || []).join('、')}</p>
              <button onClick={() => setLutPreviewId(selectedNode.id)}>3D 预览与编辑数据</button>
              <button onClick={() => setEditingExprId(String((selectedNode.data as any).ownerId))}>编辑所属函数</button>
            </div>
          ) : selectedNode && (selectedNode.data as any)?.kind === 'signal' ? (
            <div className="expr-props-empty signal-end-editor">
              <div className="signal-panel-heading">
                <div><span>信号端点</span><strong>信号属性</strong></div>
                <span className={`signal-panel-role ${(selectedNode.data as any).signalRole === 'source' ? 'source' : 'sink'}`}>
                  {(selectedNode.data as any).signalRole === 'source' ? '输入信号' : '输出信号'}
                </span>
              </div>
              <div className="signal-panel-field">
                <label>变量名</label>
                <SignalPathInput value={String((selectedNode.data as any).signalName || '')}
                  onChange={signalName => updateComponent(selectedNode.id, { signalName })}
                  placeholder="例如 position/h-sl-ft" />
              </div>
              {(() => {
                if ((selectedNode.data as any).signalRole !== 'source') return null;
                const name = String((selectedNode.data as any).signalName || '');
                const definition = props.propertyDefinitions?.find(item => item.name === name);
                const value = definition?.attrs?.value;
                return value === undefined ? null :
                  <InitialPropertyValue key={name} value={value}
                    onChange={next => props.onPropertyValueChange?.(name, next)} />;
              })()}
              <p className="signal-panel-hint">修改变量名会更新同名连线；初始值保存到仿真机后，在下次加载模型时生效。</p>
            </div>
          ) : isSignal ? (
            <div className="expr-props-empty">
              <p>选择一个组件查看/编辑属性</p>
              <p className="expr-props-hint">
                同名信号按名称自动连线：<br />
                左侧绿色 = 输入信号，右侧橙色 = 输出信号。<br />
                从输出端拖到组件输入端口可重接连線。<br />
                顶部调色板可新增组件，Delete 删除选中组件。
              </p>
            </div>
          ) : selectedNode && selectedExpr ? (
            <BlockPropertyPanel
              expr={selectedExpr}
              onChange={handleExprUpdateNode}
              onDelete={handleDelete}
              isRoot={selectedIsRoot}
            />
          ) : (
            <div className="expr-props-empty">
              <p>选择一个模块查看/编辑属性</p>
              <p className="expr-props-hint">
                同名输入信号（如 fcs/throttle-cmd-norm）在各公式中共享一个节点。<br />
                点击左侧面板添加模块，连接模块构建公式树。
              </p>
            </div>
          )}
        </div>
        {hasFormulaView && formulaView && <FormulaNotebook nodes={nodes.filter(node => !props.moduleDisabled && !moduleIsDisabled(node.data))}
          onUpdate={(id, expression) => updateComponent(id, {
            expression, inputs: collectPropertyNodes(expression).map(property => property.name),
          })}
          onCreate={createFormula} />}
      </div>
      )}
      {contextMenu && contextTarget && <NodeContextMenu {...contextMenu}
        title={String(contextOwner?.data.name || contextTarget.data.name || '模块')}
        onClose={closeContextMenu} actions={[
          { label: '查看属性', run: () => setSelectedNodeId(contextOwner?.id || contextTarget.id) },
          { label: `${contextOwner?.data.disabled ? '取消注释（启用）' : '注释模块（停用）'}${contextOwner && contextOwner.id !== contextTarget.id ? ' · 所属函数' : ''}`,
            disabled: !contextOwner || !!props.moduleDisabled || !!contextOwner.data.channelDisabled,
            hint: props.moduleDisabled ? '请先返回主模型取消所属模块注释' : contextOwner?.data.channelDisabled ? '请先取消所在通道注释' : !contextOwner ? '请选择完整组件；表达式算子需注释所属函数' : undefined,
            run: () => contextOwner && toggleDisabled(contextOwner.id) },
          ...(contextOwner && props.allowChannelDisable !== false && typeof contextOwner.data.ch === 'number' &&
            contextOwner.data.chName !== '__JSBSIM_SYSTEM_TOP_LEVEL_FUNCTIONS__' ? [{
              label: contextOwner.data.channelDisabled ? '取消所在通道注释' : '注释所在通道（停用）',
              disabled: !!props.moduleDisabled,
              run: () => toggleDisabled(contextOwner.id, true),
            }] : []),
          ...(contextOwner?.id === contextTarget.id && !props.moduleDisabled ? [{ label: '删除模块', danger: true, run: handleDelete }] : []),
        ]} />}
      {lutPreviewNode && (
        <LutTablePreview
          title={String((lutPreviewNode.data as any).name || (lutPreviewNode.data as any).outputSignal || '插值表')}
          expression={(lutPreviewNode.data as any).expression as ExprNode}
          onChange={expression => {
            const data = lutPreviewNode.data as any;
            if (data.kind === 'tablePreview') {
              const owner = nodesRef.current.find(node => node.id === data.ownerId);
              const root = owner?.data.expression as ExprNode | undefined;
              if (root?.kind !== 'product') return;
              const next = { ...root, children: root.children.map((child, index) => index === data.factorIndex ? expression : child) };
              updateComponent(String(data.ownerId), { expression: next, inputs: collectPropertyNodes(next).map(property => property.name) });
            } else {
              updateComponent(lutPreviewNode.id, { expression, inputs: collectPropertyNodes(expression).map(property => property.name) });
            }
          }}
          onClose={() => setLutPreviewId(null)}
        />
      )}
    </>
  );

  return (
    <ExprErrorBoundary>
    <ReactFlowProvider>
      {embedded ? (
        <div className="module-canvas-root">{editorInner}</div>
      ) : (
        <div className="expr-modal-overlay" onPointerDown={event => { if (event.target === event.currentTarget) handleBack(); }}>
          <div className="expr-editor" onClick={(e) => e.stopPropagation()}>{editorInner}</div>
        </div>
      )}
    </ReactFlowProvider>
    </ExprErrorBoundary>
  );

}

// ── Signal-mode component palette ────────────────────────────────────────────
function SignalPalette({ onAdd }: { onAdd: (type: string) => void }) {
  return (
    <div className="expr-palette">
      <div className="expr-palette-title">组件</div>
      <button className="expr-palette-item monitor-palette-button" draggable onDragStart={event => { event.dataTransfer.setData('application/signal-component', 'scope'); event.dataTransfer.effectAllowed = 'copy'; }} onClick={() => onAdd('scope')}>∿ 示波器 Scope</button>
      <div className="expr-palette-items">
        {COMPONENT_PALETTE.map(type => {
          const meta = COMPONENT_META[type] || { label: type, icon: '•', color: '#64748b' };
          return (
            <button
              key={type}
              className="expr-palette-item"
              style={{ borderLeftColor: meta.color }}
              onClick={() => onAdd(type)}
              draggable
              onDragStart={event => {
                event.dataTransfer.setData('application/signal-component', type);
                event.dataTransfer.effectAllowed = 'copy';
              }}
              title={`添加 ${meta.label}`}
            >
              <span style={{ color: meta.color }}>{meta.icon}</span> {meta.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Error boundary
class ExprErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: string }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: '' };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="expr-editor" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', padding: 32 }}>
            <p style={{ color: '#ef4444', fontSize: 14, marginBottom: 12 }}>⚠️ 模块画布错误</p>
            <p style={{ color: '#666', fontSize: 12, marginBottom: 16 }}>{this.state.error}</p>
            <button onClick={() => this.setState({ hasError: false, error: '' })}
              style={{ padding: '8px 20px', background: '#3b82f6', color: '#fff', border: 'none',
                borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
              重试
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
