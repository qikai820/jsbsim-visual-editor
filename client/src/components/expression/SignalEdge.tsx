import { useContext } from 'react';
import {
  BaseEdge, getSmoothStepPath, useReactFlow, type EdgeProps,
} from '@xyflow/react';
import BendpointHandles from '../edges/BendpointHandles';
import {
  edgePoints, polylinePath, polylinePointAt, nearestSegment, type Bendpoint,
} from '../edges/bendpoints';
import { SignalEdgeActionsContext } from './signalEdgeActions';

// Signal-flow edge with draggable waypoints. Keeps the per-edge fan-out offsets
// (data.srcOffset/tgtOffset) that separate wires sharing a handle. With no
// bendpoints it renders the smoothstep path (unchanged look); double-click inserts
// a waypoint on the nearest segment; selecting the edge shows draggable handles.
// Waypoints go through SignalEdgeActionsContext back to the canvas's edges state.
export default function SignalEdge(props: EdgeProps) {
  const {
    id, sourceX, sourceY, targetX, targetY,
    sourcePosition, targetPosition, data, selected, label, markerEnd,
  } = props;
  const actions = useContext(SignalEdgeActionsContext);
  const { screenToFlowPosition } = useReactFlow();
  const srcOff = (data?.srcOffset as number) ?? 0;
  const tgtOff = (data?.tgtOffset as number) ?? 0;
  const bps: Bendpoint[] = ((data?.bendpoints as Bendpoint[]) ?? []);
  const setBps = (next: Bendpoint[]) => actions?.updateBendpoints(id, next);

  // Anchors include the fan-out offset (unchanged behaviour).
  const src = { x: sourceX, y: sourceY + srcOff };
  const tgt = { x: targetX, y: targetY + tgtOff };

  const addBp = (e: React.MouseEvent) => {
    e.stopPropagation();
    const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const pts = edgePoints(src, tgt, bps);
    const { segIndex } = nearestSegment(pts, p);
    const next = bps.slice();
    next.splice(Math.min(segIndex, bps.length), 0, p);
    setBps(next);
  };

  if (bps.length === 0) {
    const [path, lx, ly] = getSmoothStepPath({
      sourceX, sourceY: src.y, targetX, targetY: tgt.y, sourcePosition, targetPosition,
    });
    return (
      <>
        <BaseEdge id={id} path={path} labelX={lx} labelY={ly} label={label} markerEnd={markerEnd} />
        <path d={path} className="bp-add-hit" fill="none" stroke="transparent" strokeWidth={14} onDoubleClick={addBp} />
      </>
    );
  }

  const pts = edgePoints(src, tgt, bps);
  const path = polylinePath(pts, 10);
  const mid = polylinePointAt(pts, 0.5);
  return (
    <>
      <BaseEdge id={id} path={path} labelX={mid.x} labelY={mid.y} label={label} markerEnd={markerEnd} />
      <path d={path} className="bp-add-hit" fill="none" stroke="transparent" strokeWidth={14} onDoubleClick={addBp} />
      {selected && (
        <BendpointHandles
          bendpoints={bps}
          onChange={setBps}
          onDragEnd={() => actions?.persistBendpoints()}
        />
      )}
    </>
  );
}
