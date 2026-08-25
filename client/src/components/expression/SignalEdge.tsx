import { useContext, useCallback, useRef } from 'react';
import {
  BaseEdge, getSmoothStepPath, useReactFlow, useStore, type EdgeProps,
} from '@xyflow/react';
import BendpointHandles from '../edges/BendpointHandles';
import {
  edgePoints, polylinePath, polylinePointAt, nearestSegment, type Bendpoint,
} from '../edges/bendpoints';
import { SignalEdgeActionsContext } from './signalEdgeActions';

const DRAG_THRESHOLD = 4;

// Compute the implicit orthogonal routing bendpoints for a smoothstep edge.
function computeSmoothstepBps(
  srcX: number, srcY: number, tgtX: number, tgtY: number,
): Bendpoint[] {
  const midX = (srcX + tgtX) / 2;
  return [{ x: midX, y: srcY }, { x: midX, y: tgtY }];
}

// Ensure all segments are orthogonal (horizontal or vertical only).
// Inserts intermediate bendpoints at boundaries where a diagonal would appear.
function orthogonalize(
  src: { x: number; y: number },
  tgt: { x: number; y: number },
  bps: Bendpoint[],
): Bendpoint[] {
  const all = [src, ...bps, tgt];
  const result: { x: number; y: number }[] = [all[0]];

  for (let i = 1; i < all.length; i++) {
    const prev = result[result.length - 1];
    const cur = all[i];
    const sameX = Math.abs(prev.x - cur.x) < 0.5;
    const sameY = Math.abs(prev.y - cur.y) < 0.5;

    if (sameX || sameY) {
      // Already orthogonal
      result.push(cur);
    } else {
      // Diagonal — need an intermediate bendpoint.
      // Determine previous segment direction to decide the step pattern.
      let prevHoriz = true; // default for first segment
      if (result.length >= 2) {
        const pp = result[result.length - 2];
        prevHoriz = Math.abs(pp.y - prev.y) < 0.5;
      }
      let inter: { x: number; y: number };
      if (prevHoriz) {
        // prev segment horizontal → step: vertical then horizontal
        inter = { x: cur.x, y: prev.y };
      } else {
        // prev segment vertical → step: horizontal then vertical
        inter = { x: prev.x, y: cur.y };
      }
      result.push(inter);
      result.push(cur);
    }
  }

  // Strip src and tgt, return only bendpoints
  return result.slice(1, -1).map(p => ({ x: p.x, y: p.y }));
}

export default function SignalEdge(props: EdgeProps) {
  const {
    id, source, sourceHandleId, target, sourceX, sourceY, targetX, targetY,
    sourcePosition, targetPosition, data, selected, label, markerEnd,
  } = props;
  const actions = useContext(SignalEdgeActionsContext);
  const { screenToFlowPosition } = useReactFlow();
  const srcOff = (data?.srcOffset as number) ?? 0;
  const tgtOff = (data?.tgtOffset as number) ?? 0;
  const bps: Bendpoint[] = ((data?.bendpoints as Bendpoint[]) ?? []);
  const setBps = (next: Bendpoint[]) => actions?.updateBendpoints(id, next);

  const selectedNodeIds = useStore((state) =>
    state.nodes.filter(n => n.selected).map(n => n.id)
  );
  const isHighlighted = selectedNodeIds.includes(source) || selectedNodeIds.includes(target);

  // Detect fan-out
  const isBranch = useStore((state) => {
    if (!sourceHandleId) return false;
    let count = 0;
    for (const e of state.edges) {
      if (e.source === source && e.sourceHandle === sourceHandleId) {
        count++;
        if (count > 1) return true;
      }
    }
    return false;
  });

  const src = { x: sourceX, y: sourceY + srcOff };
  const tgt = { x: targetX, y: targetY + tgtOff };

  // Track whether a drag actually happened (to avoid conflict with dblclick)
  const dragMovedRef = useRef(false);

  // ── Parallel segment drag ──────────────────────────────────────────────
  const startDrag = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const startClient = { x: e.clientX, y: e.clientY };
    const startFlow = screenToFlowPosition(startClient);
    const origBps = bps;
    const pts = edgePoints(src, tgt, origBps);
    const { segIndex } = nearestSegment(pts, startFlow);

    let baseBps: Bendpoint[];
    if (origBps.length === 0) {
      baseBps = computeSmoothstepBps(sourceX, src.y, targetX, tgt.y);
    } else {
      baseBps = origBps.slice();
    }

    let dragging = false;
    dragMovedRef.current = false;

    const onMove = (me: MouseEvent) => {
      const cur = screenToFlowPosition({ x: me.clientX, y: me.clientY });
      const dx = cur.x - startFlow.x;
      const dy = cur.y - startFlow.y;

      if (!dragging) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        dragging = true;
        dragMovedRef.current = true;
      }

      const newBps = baseBps.slice();

      if (origBps.length === 0) {
        // Smoothstep bootstrap: 3 implicit segments [src, bp0, bp1, tgt]
        // Segment 0 (src→bp0, horiz): only move bp0 (start of segment)
        // Segment 1 (bp0→bp1, vert): move BOTH bp0 and bp1 (both endpoints)
        // Segment 2 (bp1→tgt, horiz): only move bp1 (start of segment)
        if (segIndex === 0) {
          if (newBps[0]) newBps[0] = { ...newBps[0], y: newBps[0].y + dy };
        } else if (segIndex === 1) {
          if (newBps[0]) newBps[0] = { ...newBps[0], x: newBps[0].x + dx };
          if (newBps[1]) newBps[1] = { ...newBps[1], x: newBps[1].x + dx };
        } else {
          if (newBps[1]) newBps[1] = { ...newBps[1], y: newBps[1].y + dy };
        }
      } else {
        const segStart = pts[segIndex];
        const segEnd = pts[segIndex + 1];
        const isHoriz = Math.abs(segEnd.y - segStart.y) <= Math.abs(segEnd.x - segStart.x);
        // Move from bp[segIndex-1] — this is the START endpoint of the dragged segment.
        // Moving both endpoints keeps the segment parallel to its original direction.
        const firstIdx = segIndex - 1;
        if (firstIdx >= 0 && firstIdx < newBps.length) {
          if (isHoriz) {
            for (let i = firstIdx; i < newBps.length; i++)
              newBps[i] = { ...newBps[i], y: newBps[i].y + dy };
          } else {
            for (let i = firstIdx; i < newBps.length; i++)
              newBps[i] = { ...newBps[i], x: newBps[i].x + dx };
          }
        }
      }

      setBps(orthogonalize(src, tgt, newBps));
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (dragging) actions?.persistBendpoints();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [bps, src, tgt, sourceX, sourceY, targetX, targetY, screenToFlowPosition, setBps, actions]);

  const addBp = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (dragMovedRef.current) { dragMovedRef.current = false; return; }
    const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const pts = edgePoints(src, tgt, bps);
    const { segIndex } = nearestSegment(pts, p);
    const next = bps.slice();
    next.splice(Math.min(segIndex, bps.length), 0, p);
    setBps(orthogonalize(src, tgt, next));
  };

  const junction = isBranch ? (
    <circle
      cx={src.x}
      cy={src.y}
      r={4}
      fill="#333"
      stroke="#fff"
      strokeWidth={1.5}
      className="signal-junction"
      style={{ pointerEvents: 'none' }}
    />
  ) : null;

  const hitPathProps = {
    className: 'bp-add-hit',
    fill: 'none',
    stroke: 'transparent',
    strokeWidth: 14,
    onDoubleClick: addBp,
    onMouseDown: startDrag,
    style: { cursor: 'crosshair' } as React.CSSProperties,
  };

  if (bps.length === 0) {
    const [path, lx, ly] = getSmoothStepPath({
      sourceX, sourceY: src.y, targetX, targetY: tgt.y, sourcePosition, targetPosition,
    });
    return (
      <>
        <BaseEdge id={id} path={path} labelX={lx} labelY={ly} label={label} markerEnd={markerEnd}
          style={isHighlighted ? { stroke: '#f59e0b', strokeWidth: 2.5 } : undefined} />
        <path d={path} {...hitPathProps} />
        {junction}
      </>
    );
  }

  const pts = edgePoints(src, tgt, bps);
  const path = polylinePath(pts, 10);
  const mid = polylinePointAt(pts, 0.5);
  return (
    <>
      <BaseEdge id={id} path={path} labelX={mid.x} labelY={mid.y} label={label} markerEnd={markerEnd}
        style={isHighlighted ? { stroke: '#f59e0b', strokeWidth: 2.5 } : undefined} />
      <path d={path} {...hitPathProps} />
      {junction}
      {selected && (
        <BendpointHandles bendpoints={bps}
          onChange={(next) => setBps(orthogonalize(src, tgt, next))}
          onDragEnd={() => actions?.persistBendpoints()} />
      )}
    </>
  );
}
