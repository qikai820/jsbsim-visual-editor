import { useCallback, useRef } from 'react';
import {
  ReactFlow, Background, Controls, MiniMap, SelectionMode,
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
const MODULE_TYPES = new Set(['system', 'flight_control']);

export default function Canvas({ dragType }: CanvasProps) {
  const { nodes, edges, onNodesChange, onEdgesChange, onConnect, addNode, setSelectedNode, updateNodeParams, setFocusedNodeId } = useFlowStore();
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const rfInstance = useRef<ReactFlowInstance | null>(null);

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    if (!dragType) return;

    const bounds = reactFlowWrapper.current?.getBoundingClientRect();
    if (!bounds || !rfInstance.current) return;

    const position = rfInstance.current.screenToFlowPosition({
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    });

    addNode(dragType, position);
  }, [dragType, addNode]);

  const onNodeClick = useCallback((_: any, node: any) => {
    setSelectedNode(node.id);
  }, [setSelectedNode]);

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
  }, [setSelectedNode]);

  // Double-click a module (system / flight_control) to drill into its internal
  // signal-flow canvas. Ensure channels/layout params exist so the embedded
  // ModuleExpressionCanvas can mount cleanly on a fresh module node.
  const onNodeDoubleClick = useCallback((_: any, node: any) => {
    const t = node.data?.componentType;
    if (!MODULE_TYPES.has(t)) return;
    const params = node.data?.params || {};
    const patch: Record<string, any> = {};
    if (!('channels' in params) || !params.channels) patch.channels = '[]';
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
        <Controls />
        <MiniMap />
      </ReactFlow>
    </div>
  );
}
