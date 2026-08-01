import { useState, useCallback, useRef, useMemo, useEffect, Component, type ReactNode } from 'react';
import {
  ReactFlow, Background, Controls, MiniMap,
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
  assignSignalEdgeOffsets,
} from '../../utils/signalGraph';
import SignalEdge from './SignalEdge';
import FunctionBlockNode from './FunctionBlockNode';
import SignalBlockNode from './SignalBlockNode';
import SignalEndNode from './SignalEndNode';
import ExpressionPalette from './ExpressionPalette';
import { BlockPropertyPanel } from './BlockPropertyPanel';
import ComponentPropertyPanel from './ComponentPropertyPanel';
import ExpressionEditor from './ExpressionEditor';

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
      const isProp = n.data?.exprNode?.kind === 'property';
      if (isProp) {
        const pname = (n.data.exprNode as any).name;
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
    offsetX = localMaxX + offsetX + 160;
  });

  return { nodes, edges, rootIds };
}

// ── Reconcile signal-flow endpoints + edges from node data (signal mode) ─────
// Single source of truth = component node data (name / inputs / compProps /
// expression). Edges and source/sink endpoint nodes are always derived.
function recomputeGraph(nodes: any[]): { nodes: any[]; edges: any[] } {
  const comps = nodes.filter(n => n.data?.kind === 'component');
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

  const finalNodes = [...comps, ...endpoints];
  const edges: any[] = [];
  for (const c of comps) {
    (c.data.inputs || []).forEach((s: string, i: number) => {
      if (!s) return;
      const prod = producers.get(s);
      const source = prod ? prod : `src-${s}`;
      edges.push({ id: `e-${source}-${c.id}-${i}`, source, sourceHandle: 'out', target: c.id, targetHandle: `in-${i}`, label: s, data: { signal: s }, type: 'signal' });
    });
  }
  for (const s of neededSinks) {
    const prod = producers.get(s)!;
    edges.push({ id: `e-${prod}-sink-${s}`, source: prod, sourceHandle: 'out', target: `sink-${s}`, targetHandle: 'in', label: s, data: { signal: s }, type: 'signal' });
  }
  // Fan out wires sharing a handle so they don't overlap (visual only).
  assignSignalEdgeOffsets(edges);
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

  const initial = useMemo(() => {
    const g = isSignal ? buildSignalGraph(channels, topLevelProps) : buildMergedGraph(expressions);
    // Restore saved positions for this model, if any.
    if (initialLayout) {
      for (const n of g.nodes) {
        const p = initialLayout[n.id];
        if (p) n.position = { x: p.x, y: p.y };
      }
    }
    return g;
  }, []); // build once on mount

  const [nodes, setNodes] = useState<Node[]>(initial.nodes);
  const [edges, setEdges] = useState<Edge[]>(initial.edges);
  const rootIdsRef = useRef<Record<string, string>>({});
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const rfWrapper = useRef<HTMLDivElement>(null);
  const rfInstance = useRef<ReactFlowInstance | null>(null);

  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);

  // Per-model layout persistence (optional).
  const onLayoutChangeRef = useRef(onLayoutChange);
  useEffect(() => { onLayoutChangeRef.current = onLayoutChange; }, [onLayoutChange]);

  function layoutFromNodes(ns: any[]): Record<string, { x: number; y: number }> {
    const layout: Record<string, { x: number; y: number }> = {};
    for (const n of ns) {
      if (n.type === 'signalBlock' || n.type === 'functionBlock') {
        layout[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
      }
    }
    return layout;
  }
  const persistLayout = useCallback(() => {
    if (onLayoutChangeRef.current) onLayoutChangeRef.current(layoutFromNodes(nodesRef.current));
  }, []);

  // ── Signal-mode commit (recompute edges + report channel changes) ──
  const commitSignal = useCallback((nextNodes: any[]) => {
    const { nodes: rn, edges: re } = recomputeGraph(nextNodes);
    setNodes(rn);
    setEdges(re);
    const ch = graphToChannels(rn, re);
    onChannelsChange?.(ch);
    persistLayout();
  }, [onChannelsChange, persistLayout]);

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
    setNodes(ns => applyNodeChanges(changes, ns));
  }, []);
  const onNodeDragStop = useCallback(() => {
    if (isSignal) {
      setTimeout(() => commitSignal(nodesRef.current), 0);
    } else {
      setTimeout(syncToTree, 0);
      persistLayout();
    }
  }, [isSignal, commitSignal, syncToTree, persistLayout]);

  // Re-run the optimized auto-layout (barycenter ordering + channel lanes).
  // Bound the layout to <=150% of the canvas so it stays readable (fitView
  // then shows it at zoom >= ~0.67). Flow units == px at zoom 1.
  const handleAutoLayout = useCallback(() => {
    let maxExtent: { w: number; h: number } | undefined;
    if (isSignal && rfWrapper.current) {
      maxExtent = {
        w: rfWrapper.current.clientWidth * 1.5,
        h: rfWrapper.current.clientHeight * 1.5,
      };
    }
    const g = isSignal
      ? buildSignalGraph(channels, topLevelProps, { maxExtent })
      : buildMergedGraph(expressions);
    setNodes(g.nodes);
    setEdges(g.edges);
    if (onLayoutChangeRef.current) onLayoutChangeRef.current(layoutFromNodes(g.nodes));
    setTimeout(() => rfInstance.current?.fitView({ padding: 0.2, duration: 300 }), 0);
  }, [isSignal, channels, topLevelProps, expressions]);
  const onEdgesChange = useCallback((changes: any) => {
    setEdges(es => applyEdgeChanges(changes, es));
  }, []);
  const onConnect = useCallback((connection: Connection) => {
    if (isSignal) {
      const src = nodesRef.current.find(n => n.id === connection.source);
      const tgt = nodesRef.current.find(n => n.id === connection.target);
      if (!src || !tgt || tgt.data?.kind !== 'component') return;
      const outSig = src.data?.kind === 'component'
        ? (src.data.outputSignal || src.data.name)
        : src.data?.signalName;
      const idx = parseInt(String(connection.targetHandle).replace('in-', ''), 10);
      if (isNaN(idx) || !outSig) return;
      const next = nodesRef.current.map(n => {
        if (n.id !== tgt.id) return n;
        const inputs = [...(n.data.inputs || [])];
        inputs[idx] = outSig;
        return { ...n, data: { ...n.data, inputs } };
      });
      commitSignal(next);
      return;
    }
    setEdges(es => addEdge({ ...connection, type: 'smoothstep', animated: false }, es));
    setTimeout(syncToTree, 0);
  }, [isSignal, commitSignal, syncToTree]);

  const onNodeClick = useCallback((_: any, node: Node) => {
    setSelectedNodeId(node.id);
  }, []);

  // Double-click a function/fcs_function block to open its expression editor.
  const onNodeDoubleClick = useCallback((_: any, node: Node) => {
    const d = node.data;
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
  const editingNode = nodes.find(n => n.id === editingExprId);
  const handleExprSave = useCallback((expr: ExprNode) => {
    if (editingExprId) updateComponent(editingExprId, { expression: expr });
    setEditingExprId(null);
  }, [editingExprId, updateComponent]);

  // ── Add / delete components (signal mode) ──
  const handleAddComponent = useCallback((type: string) => {
    const meta = COMPONENT_META[type] || { label: type, icon: '•', color: '#64748b' };
    const id = `c-new-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const inputs = SINGLE_INPUT_TYPES.has(type) ? [''] : ['', ''];
    const compProps: any = {};
    if (type === 'pure_gain') compProps.gain = { value: '1', attrs: {} };
    if (type === 'pid') { compProps.kp = { value: '1', attrs: {} }; compProps.ki = { value: '0', attrs: {} }; compProps.kd = { value: '0', attrs: {} }; }
    let position = { x: 400, y: 200 };
    if (rfInstance.current && rfWrapper.current) {
      const b = rfWrapper.current.getBoundingClientRect();
      const p = rfInstance.current.screenToFlowPosition({ x: b.width / 2, y: b.height / 2 });
      position = { x: p.x + (Math.random() - 0.5) * 60, y: p.y + (Math.random() - 0.5) * 60 };
    }
    const newNode: any = {
      id, type: 'signalBlock', position,
      data: {
        kind: 'component', itemType: type, name: '', outputSignal: '',
        inputs, expression: type === 'function' ? { kind: 'value', value: 0 } : undefined,
        compProps, ch: 0, chName: '', itemIdx: 0, meta,
      },
    };
    commitSignal([...nodesRef.current, newNode]);
    setSelectedNodeId(id);
  }, [commitSignal]);

  const handleDelete = useCallback(() => {
    if (!selectedNodeId) return;
    const next = nodesRef.current.filter(n => n.id !== selectedNodeId);
    commitSignal(next);
    setSelectedNodeId(null);
  }, [selectedNodeId, commitSignal]);

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
    if (rfInstance.current) rfInstance.current.fitView({ padding: 0.2, duration: 300 });
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
          <button className="expr-layout-btn" onClick={handleAutoLayout} title="重新自动布局（减少连线交叉）">⤢ 自动布局</button>
          <button className="expr-fit-btn" onClick={handleFitView} title="适应视图">⊞ 居中</button>
          <button className="expr-apply-btn" onClick={handleBack}>✓ 完成</button>
        </div>
      </div>

      {!isSignal && !hasExprs ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, color: '#888' }}>
          该模块没有可编辑的公式
        </div>
      ) : (
      <div className="expr-editor-main">
        {isSignal ? (
          <SignalPalette onAdd={handleAddComponent} />
        ) : (
          <ExpressionPalette onAddBlock={handleAddBlock} />
        )}

        <div
          className="expr-canvas-wrapper"
          ref={rfWrapper}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
        >
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
            deleteKeyCode={null}
            snapToGrid
            snapGrid={[20, 20]}
            nodesDraggable
            nodesConnectable
            elementsSelectable
            connectionMode={ConnectionMode.Loose}
            edgeTypes={edgeTypes}
          >
            <Background gap={20} size={1} />
            <Controls />
            <MiniMap />
          </ReactFlow>
        </div>

        <div className="expr-props">
          {editingExprId && editingNode ? (
            <ExpressionEditor
              expression={editingNode.data.expression}
              onChange={handleExprSave}
              onBack={() => setEditingExprId(null)}
            />
          ) : selectedNode && selectedNode.data?.kind === 'component' ? (
            <ComponentPropertyPanel
              data={selectedNode.data}
              onChange={(patch) => updateComponent(selectedNode.id, patch)}
              onDelete={handleDelete}
              onEditExpression={(selectedNode.data.itemType === 'function' || selectedNode.data.itemType === 'fcs_function')
                ? () => setEditingExprId(selectedNode.id) : undefined}
            />
          ) : selectedNode && selectedNode.data?.kind === 'signal' ? (
            <div className="expr-props-empty">
              <p>信号端点</p>
              <p className="expr-props-hint">
                {selectedNode.data.signalRole === 'source' ? '输入信号' : '输出信号'}：<br />
                <code>{selectedNode.data.signalName}</code>
              </p>
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
      </div>
      )}
    </>
  );

  return (
    <ExprErrorBoundary>
    <ReactFlowProvider>
      {embedded ? (
        <div className="module-canvas-root">{editorInner}</div>
      ) : (
        <div className="expr-modal-overlay" onClick={handleBack}>
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
