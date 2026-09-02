import {
  BaseEdge, getSmoothStepPath, useReactFlow, type EdgeProps,
} from '@xyflow/react';
import { useFlowStore } from '../../store/flowStore';
import BendpointHandles from './BendpointHandles';
import {
  edgePoints, polylinePath, polylinePointAt, nearestSegment, type Bendpoint,
} from './bendpoints';

// Main-canvas edge with draggable waypoints (bendpoints). With no bendpoints it
// renders the standard smoothstep path (unchanged look); double-click inserts a
// waypoint on the nearest segment; selecting the edge shows draggable handles.
// Waypoints persist via edge.data.bendpoints through the project JSON.
export default function BendableEdge(props: EdgeProps) {
  const {
    id, sourceX, sourceY, targetX, targetY,
    sourcePosition, targetPosition, data, selected, label, markerEnd,
  } = props;
  const updateEdgeData = useFlowStore(s => s.updateEdgeData);
  const { screenToFlowPosition } = useReactFlow();
  const bps: Bendpoint[] = ((data?.bendpoints as Bendpoint[]) ?? []);
  const setBps = (next: Bendpoint[]) => updateEdgeData(id, { bendpoints: next });

  const addBp = (e: React.MouseEvent) => {
    e.stopPropagation();
    const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const pts = edgePoints({ x: sourceX, y: sourceY }, { x: targetX, y: targetY }, bps);
    const { segIndex } = nearestSegment(pts, p);
    const next = bps.slice();
    next.splice(Math.min(segIndex, bps.length), 0, p);
    setBps(next);
  };

  if (bps.length === 0) {
    const [path, lx, ly] = getSmoothStepPath({
      sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
    });
    return (
      <>
        <BaseEdge id={id} path={path} labelX={lx} labelY={ly} label={label} markerEnd={markerEnd} />
        <path d={path} className="bp-add-hit" fill="none" stroke="transparent" strokeWidth={14} onDoubleClick={addBp} />
      </>
    );
  }

  const pts = edgePoints({ x: sourceX, y: sourceY }, { x: targetX, y: targetY }, bps);
  const path = polylinePath(pts, 10);
  const mid = polylinePointAt(pts, 0.5);
  return (
    <>
      <BaseEdge id={id} path={path} labelX={mid.x} labelY={mid.y} label={label} markerEnd={markerEnd} />
      <path d={path} className="bp-add-hit" fill="none" stroke="transparent" strokeWidth={14} onDoubleClick={addBp} />
      {selected && <BendpointHandles bendpoints={bps} onChange={setBps} />}
    </>
  );
}

