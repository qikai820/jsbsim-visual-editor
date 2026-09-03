import { useCallback, useEffect, useRef } from 'react';
import {
  ReactFlow, Background, Controls, ControlButton, MiniMap, SelectionMode,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useFlowStore } from '../store/flowStore';
import AircraftNode from './nodes/AircraftNode';
import BendableEdge from './edges/BendableEdge';
import type { ComponentType } from '../types';

const nodeTypes = { aircraftComponent: AircraftNode };
// Map the built-in 'smoothstep' edge type (used by onConnect) to the bendable
// edge so existing edges gain waypoints with no data migration.
const edgeTypes = { smoothstep: BendableEdge, bendable: BendableEdge };

interface CanvasProps {
  onDragStart: (type: ComponentType) => void;
  dragType: ComponentType | null;
}

// Node types that own an internal signal-flow "module canvas".
const MODULE_TYPES = new Set(['system', 'flight_control', 'aero_coefficients']);

export default function Canvas({ dragType }: CanvasProps) {
  const { nodes, edges, onNodesChange, onEdgesChange, onConnect, addNode, setSelectedNode, updateNodeParams, setFocusedNodeId, restoreLayout } = useFlowStore();
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

  // Double-click a module (system / flight_control / aero_coefficients) to drill into its internal
  // signal-flow canvas. Ensure channels/layout params exist so the embedded
  // ModuleExpressionCanvas can mount cleanly on a fresh module node.
  const onNodeDoubleClick = useCallback((_: any, node: any) => {
    const t = node.data?.componentType;
    if (!MODULE_TYPES.has(t)) return;
    const params = node.data?.params || {};
    const patch: Record<string, any> = {};
    if (t !== 'aero_coefficients' && (!('channels' in params) || !params.channels)) patch.channels = '[]';
    if (!('layout' in params) || !params.layout) patch.layout = '{}';
    if (Object.keys(patch).length) updateNodeParams(node.id, patch);
    setFocusedNodeId(node.id);
  }, [updateNodeParams, setFocusedNodeId]);

  return (
    <div className="canvas-wrapper" ref={reactFlowWrapper}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onInit={(instance) => { rfInstance.current = instance; }}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onNodeClick={onNodeClick}
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
      </ReactFlow>
    </div>
  );
}
