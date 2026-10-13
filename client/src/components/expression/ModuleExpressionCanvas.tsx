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
import { SignalEdgeActionsContext } from './signalEdgeActions';
import type { Bendpoint } from '../edges/bendpoints';
import { layoutSignalGraph } from '../../utils/signalLayout';
import { routeSignalGraph } from '../../utils/signalRouting';
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

const nodeTypes = {
  functionBlock: FunctionBlockNode,
  signalBlock: SignalBlockNode,
  signalEnd: SignalEndNode,
};

// Custom edge that fans out wires sharing a handle (see SignalEdge). Stable
// reference so ReactFlow doesn't warn about changing edgeTypes identity.
const edgeTypes = { signal: SignalEdge };

export interface ModuleExpression {
  id: string;
  name: string;
  expression: ExprNode;
}

interface ModuleExpressionCanvasProps {
  expressions?: ModuleExpression[];
  onChange?: (id: string, expr: ExprNode) => void;
  channels?: any[];
  topLevelProps?: string[];
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
  initialOpenComponentId?: string;
  findPropertySource?: (signal: string) => { label: string } | null;
  onOpenPropertySource?: (signal: string) => void;
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
    const sub = treeToGraph(exprItem.expression);
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
  const isSignal = mode === 'signal' || channels != null;
  const hasFormulaView = mode === 'signal' || props.channels != null;

  const initial = useMemo(() => {
    const g = isSignal ? buildSignalGraph(channels, topLevelProps) : buildMergedGraph(expressions);
    // Restore saved positions for this model, if any.
    if (initialLayout) {
      for (const n of g.nodes) {
        const p = initialLayout[n.id];
        if (p) n.position = { x: p.x, y: p.y };
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
  const rootIdsRef = useRef<Record<string, string>>({});
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // In-canvas function expansion (MVP: at most one function expanded at a time).
  const [expandedFnId, setExpandedFnId] = useState<string | null>(null);
  const rfWrapper = useRef<HTMLDivElement>(null);
  const rfInstance = useRef<ReactFlowInstance | null>(null);
  const [layoutBusy, setLayoutBusy] = useState(false);
  const [routingBusy, setRoutingBusy] = useState(false);
  const [formulaView, setFormulaView] = useState(false);
  const [layoutError, setLayoutError] = useState('');
  const layoutRequest = useRef(0);
  useEffect(() => () => { layoutRequest.current++; }, []);

  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);

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
    const { nodes: rn, edges: re } = recomputeGraph(nextNodes, edgesRef.current);
    nodesRef.current = rn;
    edgesRef.current = re;
    setNodes(rn);
    setEdges(re);
    const ch = graphToChannels(rn, re);
    onChannelsChange?.(ch);
    persistLayout();
  }, [onChannelsChange, persistLayout]);

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

    const sub = treeToGraph(expr);
    const pref = (id: string) => `${fnId}/exp/${id}`;
    const subNodes = sub.nodes.map(n => ({
      ...n,
      id: pref(n.id),
      data: { ...n.data, kind: 'exprBlock', ownerId: fnId, inSignalFlow: true },
    }));
    const subEdges = sub.edges.map(e => ({
      ...e, id: pref(e.id), source: pref(e.source), target: pref(e.target),
      data: { kind: 'expr-internal', ownerId: fnId },
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
      setLayoutBusy(false);
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
  const onNodeDragStop = useCallback(() => {
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
    const request = ++layoutRequest.current;
    const inputNodes = nodesRef.current;
    const inputEdges = edgesRef.current;
    setLayoutBusy(true);
    setLayoutError('');
    try {
      const bounds = rfWrapper.current;
      const g = isSignal
        ? await layoutSignalGraph(inputNodes, inputEdges, instance.getInternalNode,
          bounds ? bounds.clientWidth / Math.max(1, bounds.clientHeight) : 1.6)
        : buildMergedGraph(expressions);
      if (request !== layoutRequest.current) return;
      // Never overwrite graph edits made while the asynchronous solver ran.
      if (nodesRef.current !== inputNodes || edgesRef.current !== inputEdges) {
        setLayoutError('画布已变化，请重新整理布局。');
        return;
      }
      nodesRef.current = g.nodes;
      edgesRef.current = g.edges;
      setNodes(g.nodes);
      setEdges(g.edges);
      persistLayout();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (request === layoutRequest.current) instance.fitView({ padding: 0.08, maxZoom: 1.4, duration: 300 });
      }));
    } catch (error) {
      console.error('[signal layout]', error);
      if (request === layoutRequest.current) setLayoutError('自动布局失败，已保留原布局，请重试。');
    } finally {
      if (request === layoutRequest.current) setLayoutBusy(false);
    }
  }, [isSignal, expressions, persistLayout]);

  // Reroute after moves, resizes, port edits and saved-layout restoration.
  // Positions remain user-controlled; only the paths are recomputed here.
  const routingKey = JSON.stringify([
    nodes.map(n => [n.id, n.hidden, n.position, n.measured, n.dragging, n.resizing,
      n.data?.inputs, n.data?.inputCount, n.data?.manualSize]),
    edges.map(e => [e.id, e.source, e.sourceHandle, e.target, e.targetHandle, e.hidden, e.data?.bendpoints]),
  ]);
  useEffect(() => {
    if (!isSignal || layoutBusy || !nodes.length || nodes.some(n => n.dragging || n.resizing)) return;
    let cancelled = false;
    setRoutingBusy(true);
    const timer = setTimeout(async () => {
      const instance = rfInstance.current;
      if (!instance) { setRoutingBusy(false); return; }
      try {
        const routed = await routeSignalGraph(nodesRef.current, edgesRef.current, instance.getInternalNode);
        if (cancelled) return;
        const byId = new Map(routed.map(e => [e.id, e]));
        const next = edgesRef.current.map(e => {
          const r = byId.get(e.id);
          return r ? { ...e, type: r.type, data: { ...e.data, ...r.data } } : e;
        });
        edgesRef.current = next;
        setEdges(next);
        const blocked = next.filter(e => e.data?.routingBlocked).length;
        setLayoutError(blocked ? `${blocked} 条连线空间不足，请移动相邻组件或调整手动折点；也可点击自动布局。` : '');
        persistLayout();
      } catch (error) {
        console.error('[signal routing]', error);
        if (!cancelled) setLayoutError('连线整理失败，请点击自动布局重试。');
      } finally {
        if (!cancelled) setRoutingBusy(false);
      }
    }, 100);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [routingKey, isSignal, layoutBusy, persistLayout]);

  // On mount, fill the canvas with the adaptive layout — but only when no
  // saved layout exists (otherwise respect the user's persisted positions).
  useEffect(() => {
    if (!isSignal || initialLayout) return;
    let frame: number;
    let cancelled = false;
    const arrangeWhenMeasured = () => {
      if (cancelled || !nodesRef.current.length) return;
      const instance = rfInstance.current;
      if (instance && nodesRef.current.filter(n => !n.hidden).every(n => instance.getInternalNode(n.id)?.measured?.width)) {
        void handleAutoLayout();
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
  }, [isSignal, commitSignal, syncToTree, expSync]);

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
    const d = node.data;
    if (d?.kind === 'tablePreview') {
      setSelectedNodeId(node.id);
      setLutPreviewId(String(d.ownerId));
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
  }, []);
  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, []);

  // ── Signal-mode: update a component node's data ──
  const updateComponent = useCallback((id: string, patch: any) => {
    const next = nodesRef.current.map(n => {
      if (n.id !== id) return n;
      return { ...n, data: { ...n.data, ...patch } };
    });
    commitSignal(next);
  }, [commitSignal]);

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
    const meta = COMPONENT_META[type] || { label: type, icon: '•', color: '#64748b' };
    const id = `c-new-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const inputs = type === 'constant' ? [] : SINGLE_INPUT_TYPES.has(type) ? [''] : ['', ''];
    const compProps: any = {};
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
        chName: String((nodesRef.current.find(node => (node.data as any)?.kind === 'component' && (node.data as any)?.ch === 0)?.data as any)?.chName || ''),
        itemIdx: 0, meta,
      },
    };
    commitSignal([...nodesRef.current, newNode]);
    setSelectedNodeId(id);
  }, [commitSignal]);

  const createFormula = useCallback((name: string, expression: ExprNode) => {
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
        meta: COMPONENT_META.function },
    };
    commitSignal([...nodesRef.current, node]);
    setSelectedNodeId(id);
  }, [commitSignal]);

  const handleDelete = useCallback(() => {
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
  }, [selectedNodeId, commitSignal, expandedFnId, expSync]);

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
          {routingBusy && <span role="status" style={{ alignSelf: 'center', color: '#64748b', fontSize: 11 }}>整理连线…</span>}
          {!formulaView && <button className="expr-layout-btn" onClick={handleAutoLayout} disabled={layoutBusy} title="紧凑排列模块，按端口整理直角连线">{layoutBusy ? '整理中…' : '⤢ 自动布局'}</button>}
          {!formulaView && <button className="expr-fit-btn" onClick={handleFitView} title="适应视图">⊞ 居中</button>}
          <button className="expr-apply-btn" onClick={handleBack}>✓ 完成</button>
        </div>
      </div>

      {layoutError && <div role="status" style={{ padding: '6px 12px', color: '#b45309' }}>{layoutError}</div>}

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
        {isSignal ? (
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
          <SignalEdgeActionsContext.Provider value={{ updateBendpoints: updateEdgeBendpoints, updateFanoutRoute, persistBendpoints }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeDragStop={onNodeDragStop}
            nodeTypes={nodeTypes}
            onInit={(instance) => { rfInstance.current = instance; }}
            onNodeClick={onNodeClick}
            onNodeDoubleClick={onNodeDoubleClick}
            onPaneClick={onPaneClick}
            fitView
            fitViewOptions={{ padding: 0.08, maxZoom: 1.4 }}
            minZoom={0.05}
            deleteKeyCode={null}
            snapToGrid
            snapGrid={[20, 20]}
            nodesDraggable={!layoutBusy}
            nodesConnectable={!layoutBusy}
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
          </SignalEdgeActionsContext.Provider>
        </div>

        <div className="expr-props">
          {editingExprId && editingNode ? (
            <ExpressionEditor
              expression={(editingNode.data as any).expression as ExprNode}
              onChange={handleExprSave}
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
                ? () => setEditingExprId(selectedNode.id) : undefined}
            />
          ) : selectedNode && (selectedNode.data as any)?.kind === 'tablePreview' ? (
            <div className="expr-props-empty">
              <p>{String((selectedNode.data as any).expression?.tableType || '')} 插值表</p>
              <p className="expr-props-hint">输入：{((selectedNode.data as any).inputs || []).join('、')}</p>
              <button onClick={() => setLutPreviewId(String((selectedNode.data as any).ownerId))}>查看插值数据</button>
              <button onClick={() => setEditingExprId(String((selectedNode.data as any).ownerId))}>编辑所属函数</button>
            </div>
          ) : selectedNode && (selectedNode.data as any)?.kind === 'signal' ? (
            <div className="expr-props-empty signal-end-editor">
              <p>信号端点</p>
              <label>类型</label>
              <input value={(selectedNode.data as any).signalRole === 'source' ? '输入信号' : '输出信号'} readOnly />
              <label>变量名</label>
              <SignalPathInput value={String((selectedNode.data as any).signalName || '')}
                onChange={signalName => updateComponent(selectedNode.id, { signalName })}
                placeholder="例如 position/h-sl-ft" />
              <p className="expr-props-hint">修改后会自动更新同名信号连线。</p>
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
        {hasFormulaView && formulaView && <FormulaNotebook nodes={nodes}
          onUpdate={(id, expression) => updateComponent(id, {
            expression, inputs: collectPropertyNodes(expression).map(property => property.name),
          })}
          onCreate={createFormula} />}
      </div>
      )}
      {lutPreviewNode && (
        <LutTablePreview
          title={String((lutPreviewNode.data as any).name || (lutPreviewNode.data as any).outputSignal || '插值表')}
          expression={(lutPreviewNode.data as any).expression as ExprNode}
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
