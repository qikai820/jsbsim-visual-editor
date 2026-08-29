import { useContext, useCallback, useRef, useState } from 'react';
import {
  BaseEdge, getSmoothStepPath, useReactFlow, useStore, type EdgeProps,
} from '@xyflow/react';
import BendpointHandles from '../edges/BendpointHandles';
import {
  edgePoints, polylinePath, polylinePointAt, nearestSegment, type Bendpoint,
} from '../edges/bendpoints';
import { SignalEdgeActionsContext } from './signalEdgeActions';

const DRAG_THRESHOLD = 4;

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
  const routeOffset = (data?.routeOffset as number) ?? 0;
  const configuredRouteX = data?.routeX as number | undefined;
  const bps: Bendpoint[] = ((data?.bendpoints as Bendpoint[]) ?? []);
  const setBps = (next: Bendpoint[]) => actions?.updateBendpoints(id, next);
  const [hovered, setHovered] = useState(false);

  const selectedNodeIds = useStore((state) =>
    state.nodes.filter(n => n.selected).map(n => n.id)
  );
  const flowNodes = useStore((state) => state.nodes);
  const isHighlighted = selectedNodeIds.includes(source) || selectedNodeIds.includes(target);
  const showLabel = selected || hovered || isHighlighted;
  const edgeStyle = isHighlighted || selected
    ? { stroke: '#f59e0b', strokeWidth: 2.6 }
    : { stroke: '#64748b', strokeWidth: 1.35, strokeOpacity: 0.78 };

  const fanOutCount = useStore((state) => sourceHandleId == null ? 0 :
    state.edges.filter(e => e.source === source && e.sourceHandle === sourceHandleId).length
  );
  const isFanOut = fanOutCount > 1;
  const showJunction = fanOutCount > 2;

  const src = { x: sourceX, y: sourceY + srcOff };
  const tgt = { x: targetX, y: targetY + tgtOff };
  const autoRouteX = configuredRouteX ?? ((sourceX + targetX) / 2 + routeOffset);
  // A straight wire is always the shortest and clearest route. Only use it
  // when the horizontal segment does not pass through another module body.
  const straightClear = Math.abs(src.y - tgt.y) < 2 && !flowNodes.some((node: any) => {
    if (node.id === source || node.id === target || node.hidden) return false;
    const width = node.measured?.width ?? node.data?.layoutWidth ?? 94;
    const height = node.measured?.height ?? node.data?.layoutHeight ?? 58;
    const left = node.position.x - 8;
    const right = node.position.x + width + 8;
    const top = node.position.y - 8;
    const bottom = node.position.y + height + 8;
    return src.y >= top && src.y <= bottom &&
      Math.max(Math.min(src.x, tgt.x), left) <= Math.min(Math.max(src.x, tgt.x), right);
  });

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
      baseBps = [{ x: autoRouteX, y: src.y }, { x: autoRouteX, y: tgt.y }];
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
        // Simulink-like parallel segment drag. End ports stay fixed; dragging a
        // horizontal segment creates two short vertical compensation segments.
        if (segIndex === 0) {
          const stubX = sourceX + Math.sign(autoRouteX - sourceX || 1) * 20;
          newBps.splice(0, newBps.length,
            { x: stubX, y: src.y },
            { x: stubX, y: src.y + dy },
            { x: autoRouteX, y: src.y + dy },
            { x: autoRouteX, y: tgt.y });
        } else if (segIndex === 1) {
          if (isFanOut) {
            actions?.updateFanoutRoute(source, sourceHandleId, autoRouteX + dx);
            return;
          }
          newBps[0] = { ...newBps[0], x: autoRouteX + dx };
          newBps[1] = { ...newBps[1], x: autoRouteX + dx };
        } else {
          const stubX = targetX - Math.sign(targetX - autoRouteX || 1) * 20;
          newBps.splice(0, newBps.length,
            { x: autoRouteX, y: src.y },
            { x: autoRouteX, y: tgt.y + dy },
            { x: stubX, y: tgt.y + dy },
            { x: stubX, y: tgt.y });
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
  }, [bps, src, tgt, source, sourceHandleId, sourceX, targetX, autoRouteX, isFanOut, screenToFlowPosition, setBps, actions]);

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

  const hitPathProps = {
    className: 'bp-add-hit',
    fill: 'none',
    stroke: 'transparent',
    strokeWidth: 14,
    onDoubleClick: addBp,
    onMouseDown: startDrag,
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
    style: { cursor: 'crosshair' } as React.CSSProperties,
  };

  if (bps.length === 0) {
    const branchX = autoRouteX;
    const [path, lx, ly] = straightClear
      ? [`M ${src.x},${src.y} L ${tgt.x},${tgt.y}`, (src.x + tgt.x) / 2, src.y] as [string, number, number]
      : getSmoothStepPath({
          sourceX, sourceY: src.y, targetX, targetY: tgt.y, sourcePosition, targetPosition,
          centerX: branchX,
          borderRadius: 5,
        });
    return (
      <>
        <BaseEdge id={id} path={path} labelX={lx} labelY={ly} label={showLabel ? label : undefined}
          labelStyle={{ fill: '#0f172a', fontSize: 11, fontWeight: 600 }}
          labelBgStyle={{ fill: '#ffffff', fillOpacity: 0.94 }}
          labelBgPadding={[4, 3]} labelBgBorderRadius={3}
          markerEnd={markerEnd} style={edgeStyle} />
        <path d={path} {...hitPathProps} />
        {showJunction && (
          <circle cx={branchX} cy={tgt.y} r={2.8} fill="#111" className="signal-junction"
            style={{ pointerEvents: 'none' }} />
        )}
      </>
    );
  }

  const pts = edgePoints(src, tgt, bps);
  const path = polylinePath(pts, 10);
  const mid = polylinePointAt(pts, 0.5);
  return (
    <>
      <BaseEdge id={id} path={path} labelX={mid.x} labelY={mid.y} label={showLabel ? label : undefined}
        labelStyle={{ fill: '#0f172a', fontSize: 11, fontWeight: 600 }}
        labelBgStyle={{ fill: '#ffffff', fillOpacity: 0.94 }}
        labelBgPadding={[4, 3]} labelBgBorderRadius={3}
        markerEnd={markerEnd} style={edgeStyle} />
      <path d={path} {...hitPathProps} />
      {selected && (
        <BendpointHandles bendpoints={bps}
          onChange={(next) => setBps(orthogonalize(src, tgt, next))}
          onDragEnd={() => actions?.persistBendpoints()} />
      )}
    </>
  );
}
