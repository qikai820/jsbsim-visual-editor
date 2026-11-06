import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import {
  ReactFlow, Background, Controls, ControlButton, MiniMap, SelectionMode,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useFlowStore } from '../store/flowStore';
import AircraftNode from './nodes/AircraftNode';
import { MonitorGraphProvider, useMonitorGraph, monitorNodeTypes, MonitorBranch } from './monitor/MonitorGraph';
import { withSignalMonitor } from './monitor/MonitoredEdge';
import { addScopeInView } from './monitor/scopePlacement';
import BendableEdge from './edges/BendableEdge';
import type { ComponentType } from '../types';
import NodeContextMenu from './NodeContextMenu';

const nodeTypes = { aircraftComponent: AircraftNode, ...monitorNodeTypes };
// Map the built-in 'smoothstep' edge type (used by onConnect) to the bendable
// edge so existing edges gain waypoints with no data migration.
const MonitoredEdge = withSignalMonitor(BendableEdge);
const edgeTypes = { smoothstep: MonitoredEdge, bendable: MonitoredEdge, monitorBranch: MonitorBranch };

interface CanvasProps {
  onDragStart: (type: ComponentType) => void;
  dragType: ComponentType | null;
}

// Node types that own an internal signal-flow "module canvas".
const MODULE_TYPES = new Set(['system', 'flight_control', 'aero_coefficients']);

export default function Canvas({ dragType }: CanvasProps) {
  const { nodes, edges, onNodesChange, onEdgesChange, onConnect, addNode, removeNode, setSelectedNode, updateNodeParams, setFocusedNodeId, restoreLayout } = useFlowStore();
  const monitor = useMonitorGraph('main', nodes, edges);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const contextNode = nodes.find(node => node.id === contextMenu?.id);
  const disabledNodeIds = useMemo(() => new Set(nodes.filter(node => node.data.params?.disabled).map(node => node.id)), [nodes]);
  const displayedEdges = useMemo(() => monitor.edges.map(edge =>
    disabledNodeIds.has(edge.source) || disabledNodeIds.has(edge.target)
      ? { ...edge, style: { ...edge.style, stroke: '#94a3b8', strokeDasharray: '5 4' } } : edge), [monitor.edges, disabledNodeIds]);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const rfInstance = useRef<ReactFlowInstance<any, any> | null>(null);
  const fitInProgress = useRef(false);

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    const droppedType = (event.dataTransfer.getData('application/x-jsbsim-component') || dragType) as ComponentType | '';
    if (!droppedType) return;

    if (!reactFlowWrapper.current || !rfInstance.current) return;

    // screenToFlowPosition expects viewport/client coordinates.  Subtracting
    // the wrapper bounds here applies the canvas offset a second time, which
    // makes dropped nodes appear away from the mouse release point.
    const position = rfInstance.current.screenToFlowPosition({
      x: event.clientX,
      y: event.clientY,
    });

    if (droppedType === 'scope') { addScopeInView('main', rfInstance.current, reactFlowWrapper.current, position); return; }
    addNode(droppedType, position);
  }, [dragType, addNode]);

  const onNodeClick = useCallback((_: any, node: any) => {
    setSelectedNode(node.id);
  }, [setSelectedNode]);

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
  }, [setSelectedNode]);

  const onFitView = useCallback(() => {
    fitInProgress.current = true;
    window.requestAnimationFrame(() => {
      const instance = rfInstance.current;
      const wrapper = reactFlowWrapper.current;
      if (!instance || !wrapper) {
        fitInProgress.current = false;
        return;
      }
      const visibleNodes = instance.getNodes().filter(node => !node.hidden);
      if (visibleNodes.length === 0) {
        fitInProgress.current = false;
        return;
      }
      const bounds = instance.getNodesBounds(visibleNodes);
      const rect = wrapper.getBoundingClientRect();
      const padding = 0.12;
      const availableWidth = rect.width * (1 - padding * 2);
      const availableHeight = rect.height * (1 - padding * 2);
      const widthZoom = availableWidth / Math.max(bounds.width, 1);
      const heightZoom = availableHeight / Math.max(bounds.height, 1);
      const zoom = Math.min(2, Math.max(0.05, Math.min(widthZoom, heightZoom)));
      const x = rect.width / 2 - (bounds.x + bounds.width / 2) * zoom;
      const y = rect.height / 2 - (bounds.y + bounds.height / 2) * zoom;
      void instance.setViewport({ x, y, zoom }, { duration: 300 });
      window.setTimeout(() => { fitInProgress.current = false; }, 350);
    });
  }, []);

  useEffect(() => {
    let timer: number | undefined;
    const fitAfterResize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(onFitView, 120);
    };
    window.addEventListener('resize', fitAfterResize);
    return () => {
      window.removeEventListener('resize', fitAfterResize);
      window.clearTimeout(timer);
    };
  }, [onFitView]);

  const onMoveEnd = useCallback((_: MouseEvent | TouchEvent | null, viewport: { x: number; y: number; zoom: number }) => {
    if (fitInProgress.current) return;
    const instance = rfInstance.current;
    if (!instance) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    // Quantise the transform to quarter device pixels. Arbitrary fractional
    // CSS transforms make all node text intermittently look soft after zoom.
    const zoomStep = 0.25 / dpr;
    // Large aircraft graphs may need a zoom below 0.2 to fit the canvas.
    // Clamping here made the Fit View control appear to do nothing.
    const zoom = Math.min(2, Math.max(0.05, Math.round(viewport.zoom / zoomStep) * zoomStep));
    const x = Math.round(viewport.x * dpr) / dpr;
    const y = Math.round(viewport.y * dpr) / dpr;
    if (Math.abs(zoom - viewport.zoom) > 0.001 || Math.abs(x - viewport.x) > 0.01 || Math.abs(y - viewport.y) > 0.01) {
      void instance.setViewport({ x, y, zoom }, { duration: 0 });
    }
  }, []);

  // Double-click a module to drill into its internal signal-flow canvas.
  // Only initialize canvas layout metadata; that does not change XML.
  const onNodeDoubleClick = useCallback((_: any, node: any) => {
    const t = node.data?.componentType;
    if (!MODULE_TYPES.has(t)) return;
    const params = node.data?.params || {};
    const patch: Record<string, any> = {};
    // Opening an empty module does not edit its XML. The signal canvas already
    // accepts a missing channels value and creates one on the first real edit.
    if (!('layout' in params) || !params.layout) patch.layout = '{}';
    if (Object.keys(patch).length) updateNodeParams(node.id, patch);
    setFocusedNodeId(node.id);
  }, [updateNodeParams, setFocusedNodeId]);

  return (
    <div className="canvas-wrapper" ref={reactFlowWrapper}>
      <MonitorGraphProvider value={monitor.context}><ReactFlow
        nodes={monitor.nodes.map(node => disabledNodeIds.has(node.id) ? { ...node, connectable: false } : node)}
        edges={displayedEdges}
        onNodesChange={changes => { const modelChanges = monitor.filterChanges(changes); if (modelChanges.length) onNodesChange(modelChanges); }}
        onEdgesChange={onEdgesChange}
        onConnect={connection => {
          if (disabledNodeIds.has(connection.source!) || disabledNodeIds.has(connection.target!)) return;
          if (!monitor.connect(connection)) onConnect(connection);
        }}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onInit={(instance) => { rfInstance.current = instance; }}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onNodeClick={onNodeClick}
        onNodeContextMenu={(event, node) => {
          event.preventDefault(); event.stopPropagation();
          setSelectedNode(node.id);
          setContextMenu({ x: event.clientX, y: event.clientY, id: node.id });
        }}
        onNodeDoubleClick={onNodeDoubleClick}
        onPaneClick={onPaneClick}
        onMoveEnd={onMoveEnd}
        fitView
        deleteKeyCode="Delete"
        snapToGrid
        snapGrid={[15, 15]}
        selectionOnDrag
        panOnDrag={[1, 2]}
        multiSelectionKeyCode="Shift"
        selectionMode={SelectionMode.Partial}
        onPaneContextMenu={(e) => e.preventDefault()}
      >
        <Background />
        <Controls showZoom showFitView showInteractive fitViewOptions={{ padding: 0.12, minZoom: 0.05, maxZoom: 2 }} onFitView={onFitView}>
          <ControlButton onClick={restoreLayout} title="恢复紧凑布局" aria-label="恢复紧凑布局">↺</ControlButton>
        </Controls>
        <MiniMap />
      </ReactFlow></MonitorGraphProvider>
      {contextMenu && contextNode && <NodeContextMenu {...contextMenu} title={contextNode.data.label} onClose={closeContextMenu} actions={[
        { label: '查看属性', run: () => setSelectedNode(contextNode.id) },
        { label: contextNode.data.params?.disabled ? '取消注释（启用）' : '注释模块（停用）',
          disabled: !['system', 'flight_control'].includes(contextNode.data.componentType),
          hint: !['system', 'flight_control'].includes(contextNode.data.componentType) ? '支持系统和飞控模块；内部算子请注释所属函数' : undefined,
          run: () => updateNodeParams(contextNode.id, { disabled: !contextNode.data.params?.disabled }) },
        { label: '删除模块', danger: true, run: () => removeNode(contextNode.id) },
      ]} />}
    </div>
  );
}
