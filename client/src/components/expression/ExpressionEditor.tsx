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
  treeToGraph, graphToTree, createBlock, resetBlockIdCounter,
  BLOCK_DEFS,
} from '../../utils/expressionConverter';
import FunctionBlockNode from './FunctionBlockNode';
import ExpressionPalette from './ExpressionPalette';
import { BlockPropertyPanel } from './BlockPropertyPanel';

const nodeTypes = { functionBlock: FunctionBlockNode };

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
            <p style={{ color: '#ef4444', fontSize: 14, marginBottom: 12 }}>⚠️ 表达式编辑器错误</p>
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

interface ExpressionEditorProps {
  expression: ExprNode;
  onChange: (expr: ExprNode) => void;
  onBack: () => void;
}

export default function ExpressionEditor({ expression, onChange, onBack }: ExpressionEditorProps) {
  // Convert expression tree to graph (only once on mount)
  const initial = useMemo(() => {
    resetBlockIdCounter();
    return treeToGraph(expression);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [nodes, setNodes] = useState<Node[]>(initial.nodes);
  const [edges, setEdges] = useState<Edge[]>(initial.edges);
  const [rootId] = useState(initial.rootId);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const rfWrapper = useRef<HTMLDivElement>(null);
  const rfInstance = useRef<ReactFlowInstance | null>(null);

  // Use refs to track latest state for callbacks
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);

  // Sync graph back to tree (with error handling)
  const syncToTree = useCallback(() => {
    try {
      const currentNodes = nodesRef.current;
      const currentEdges = edgesRef.current;
      if (!currentNodes || currentNodes.length === 0) return;
      const tree = graphToTree(currentNodes, currentEdges, rootId);
      if (tree && tree.kind) {
        onChange(tree);
      }
    } catch (e) {
      console.warn('[ExpressionEditor] syncToTree error:', e);
    }
  }, [rootId, onChange]);

  const onNodesChange = useCallback((changes: any) => {
    setNodes(ns => applyNodeChanges(changes, ns));
  }, []);

  const onNodeDragStop = useCallback(() => {
    setTimeout(syncToTree, 0);
  }, [syncToTree]);

  const onEdgesChange = useCallback((changes: any) => {
    setEdges(es => applyEdgeChanges(changes, es));
  }, []);

  const onConnect = useCallback((connection: Connection) => {
    setEdges(es => addEdge({
      ...connection,
      type: 'smoothstep',
      animated: false,
    }, es));
    setTimeout(syncToTree, 0);
  }, [syncToTree]);

  const onNodeClick = useCallback((_: any, node: Node) => {
    setSelectedNodeId(node.id);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, []);

  // Add a new block from palette
  const handleAddBlock = useCallback((kind: string) => {
    const newExpr = createBlock(kind);
    const def = BLOCK_DEFS[kind];
    if (!def) return;

    const id = `blk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const inputCount = def.inputCount === 'variable' ? 2 : def.inputCount;

    // Position: center of viewport or offset
    let position = { x: 300, y: 200 };
    if (rfInstance.current && rfWrapper.current) {
      const bounds = rfWrapper.current.getBoundingClientRect();
      position = rfInstance.current.screenToFlowPosition({
        x: bounds.width / 2,
        y: bounds.height / 2,
      });
      position.x += (Math.random() - 0.5) * 80;
      position.y += (Math.random() - 0.5) * 80;
    }

    const newNode: Node = {
      id,
      type: 'functionBlock',
      position,
      data: {
        exprNode: newExpr,
        blockDef: def,
        inputCount,
        blockId: id,
      },
    };

    setNodes(ns => [...ns, newNode]);
    setSelectedNodeId(id);
    // Sync after adding
    setTimeout(syncToTree, 0);
  }, [syncToTree]);

  // Delete selected node
  const handleDelete = useCallback(() => {
    if (!selectedNodeId || selectedNodeId === rootId) return;
    setNodes(ns => ns.filter(n => n.id !== selectedNodeId));
    setEdges(es => es.filter(e => e.source !== selectedNodeId && e.target !== selectedNodeId));
    setSelectedNodeId(null);
    setTimeout(syncToTree, 0);
  }, [selectedNodeId, rootId, syncToTree]);

  // Update selected node's expression data (with error handling)
  const handleUpdateNode = useCallback((updatedExpr: ExprNode) => {
    if (!selectedNodeId) return;
    try {
      setNodes(ns => ns.map(n => {
        if (n.id !== selectedNodeId) return n;
        const def = BLOCK_DEFS[updatedExpr.kind];
        const inputCount = def
          ? (def.inputCount === 'variable' ? (updatedExpr as any).children?.length || 2 : def.inputCount)
          : 0;
        return {
          ...n,
          data: {
            ...n.data,
            exprNode: updatedExpr,
            blockDef: def || n.data.blockDef,
            inputCount,
          },
        };
      }));
      setTimeout(syncToTree, 0);
    } catch (e) {
      console.warn('[ExpressionEditor] handleUpdateNode error:', e);
    }
  }, [selectedNodeId, syncToTree]);

  // Apply and go back
  const handleApply = useCallback(() => {
    syncToTree();
    onBack();
  }, [syncToTree, onBack]);

  // Go back without applying changes
  const handleBack = useCallback(() => {
    onBack();
  }, [onBack]);

  // Fit view to show all nodes
  const handleFitView = useCallback(() => {
    if (rfInstance.current) {
      rfInstance.current.fitView({ padding: 0.2, duration: 300 });
    }
  }, []);

  // Selected node data
  const selectedNode = nodes.find(n => n.id === selectedNodeId);
  const selectedExpr = selectedNode?.data?.exprNode as ExprNode | undefined;

  return (
    <ExprErrorBoundary>
    <ReactFlowProvider>
    <div className="expr-modal-overlay" onClick={handleBack}>
    <div className="expr-editor" onClick={e => e.stopPropagation()}>
      {/* Top bar */}
      <div className="expr-editor-topbar">
        <button className="expr-back-btn" onClick={handleBack}>← 返回</button>
        <span className="expr-editor-title">📐 表达式编辑器 (Simulink 风格)</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="expr-fit-btn" onClick={handleFitView} title="适应视图">⊞ 居中</button>
          <button className="expr-apply-btn" onClick={handleApply}>✓ 应用</button>
        </div>
      </div>

      <div className="expr-editor-main">
        {/* Left: Palette */}
        <ExpressionPalette onAddBlock={handleAddBlock} />

        {/* Center: Canvas */}
        <div
          className="expr-canvas-wrapper"
          ref={rfWrapper}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
          onDrop={(e) => {
            e.preventDefault();
            const kind = e.dataTransfer.getData('application/expression-block');
            if (kind) {
              // Calculate drop position relative to the ReactFlow canvas
              if (rfInstance.current && rfWrapper.current) {
                const bounds = rfWrapper.current.getBoundingClientRect();
                const position = rfInstance.current.screenToFlowPosition({
                  x: e.clientX - bounds.left,
                  y: e.clientY - bounds.top,
                });
                // Create block at drop position
                const newExpr = createBlock(kind);
                const def = BLOCK_DEFS[kind];
                if (!def) return;
                const id = `blk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                const inputCount = def.inputCount === 'variable' ? 2 : def.inputCount;
                const newNode: Node = {
                  id,
                  type: 'functionBlock',
                  position,
                  data: { exprNode: newExpr, blockDef: def, inputCount, blockId: id },
                };
                setNodes(ns => [...ns, newNode]);
                setSelectedNodeId(id);
                setTimeout(syncToTree, 0);
              } else {
                handleAddBlock(kind);
              }
            }
          }}
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
            onPaneClick={onPaneClick}
            fitView
            deleteKeyCode={null}
            snapToGrid
            snapGrid={[20, 20]}
            nodesDraggable
            nodesConnectable
            elementsSelectable
            connectionMode={ConnectionMode.Loose}
          >
            <Background gap={20} size={1} />
            <Controls />
            <MiniMap />
          </ReactFlow>
        </div>

        {/* Right: Property panel for selected block */}
        <div className="expr-props">
          {selectedNode && selectedExpr ? (
            <BlockPropertyPanel
              expr={selectedExpr}
              onChange={handleUpdateNode}
              onDelete={handleDelete}
              isRoot={selectedNodeId === rootId}
            />
          ) : (
            <div className="expr-props-empty">
              <p>选择一个模块查看属性</p>
              <p className="expr-props-hint">
                从左侧面板点击添加模块，<br />连接模块构建表达式树
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
    </div>
    </ReactFlowProvider>
    </ExprErrorBoundary>
  );
}

// ── Block Property Panel ────────────────────────────────────────────────────
// (BlockPropertyPanel / TableEditor / COMMON_PROPERTIES are now defined in
//  ./BlockPropertyPanel and shared with ModuleExpressionCanvas.)
