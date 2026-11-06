import { useContext, useCallback, useRef, useState } from 'react';
import {
  BaseEdge, getSmoothStepPath, useReactFlow, useStore, type EdgeProps, type Edge,
} from '@xyflow/react';
import BendpointHandles from '../edges/BendpointHandles';
import {
  edgePoints, polylinePath, polylinePointAt, nearestSegment, type Bendpoint,
} from '../edges/bendpoints';
import { SignalEdgeActionsContext } from './signalEdgeActions';
import type { SignalRoute } from '../../utils/signalLayout';

const DRAG_THRESHOLD = 4;

// Share the fan-out index; rendering never scans every obstacle for every
// wire. Clearance is checked once by the background router.
const fanoutCache = new WeakMap<Edge[], Map<string, Map<string, number>>>();
function hasFanout(edges: Edge[], source: string, handle: string | null | undefined) {
  if (handle == null) return false;
  let index = fanoutCache.get(edges);
  if (!index) {
    index = new Map();
    for (const edge of edges) {
      if (edge.sourceHandle == null) continue;
      let handles = index.get(edge.source);
      if (!handles) index.set(edge.source, handles = new Map());
      handles.set(edge.sourceHandle, (handles.get(edge.sourceHandle) || 0) + 1);
    }
    fanoutCache.set(edges, index);
  }
  return (index.get(source)?.get(handle) || 0) > 1;
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
  const routeOffset = (data?.routeOffset as number) ?? 0;
  const configuredRouteX = data?.routeX as number | undefined;
  const manualBps = (data?.bendpoints as Bendpoint[]) ?? [];
  const route = data?.elkRoute as SignalRoute | undefined;
  const first = route?.points?.[0];
  const last = route?.points?.[route.points.length - 1];
  const useRoute = !!first && !!last &&
    Math.hypot(first.x - sourceX, first.y - sourceY) < 2 &&
    Math.hypot(last.x - targetX, last.y - targetY) < 2;
  const bps: Bendpoint[] = useRoute ? route!.points.slice(1, -1)
    : manualBps.length ? orthogonalize({ x: sourceX, y: sourceY }, { x: targetX, y: targetY }, manualBps) : [];
  const setBps = (next: Bendpoint[]) => actions?.updateBendpoints(id, next);
  const [hovered, setHovered] = useState(false);

  const isHighlighted = useStore(state => !!(state.nodeLookup.get(source)?.selected || state.nodeLookup.get(target)?.selected));
  const showLabel = selected || hovered || isHighlighted;
  const edgeStyle = data?.moduleDisabled ? { stroke: '#94a3b8', strokeWidth: 1.4, strokeDasharray: '5 4' } : isHighlighted || selected
    ? { stroke: '#f59e0b', strokeWidth: 2.6 }
    : data?.routingBlocked ? { stroke: '#b45309', strokeWidth: 1.4, strokeDasharray: '5 3' }
    : { stroke: '#475569', strokeWidth: 1.4 };

  const isFanOut = useStore(state => hasFanout(state.edges, source, sourceHandleId));

  const src = { x: sourceX, y: sourceY };
  const tgt = { x: targetX, y: targetY };
  const autoRouteX = configuredRouteX ?? ((sourceX + targetX) / 2 + routeOffset);
  const straight = Math.abs(src.y - tgt.y) < .05;

  // Track whether a drag actually happened (to avoid conflict with dblclick)
  const dragMovedRef = useRef(false);

  // ── Parallel segment drag ──────────────────────────────────────────────
  const startDrag = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const startClient = { x: e.clientX, y: e.clientY };
    const startFlow = screenToFlowPosition(startClient);
    // A straight automatic route still needs editable segment anchors.
    const origBps = useRoute && !bps.length
      ? [{ x: (src.x + tgt.x) / 2, y: src.y }, { x: (src.x + tgt.x) / 2, y: tgt.y }]
      : bps;
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
        if (firstIdx >= 0 && segIndex < newBps.length) {
          for (const i of [firstIdx, segIndex]) {
            newBps[i] = isHoriz ? { ...newBps[i], y: newBps[i].y + dy }
              : { ...newBps[i], x: newBps[i].x + dx };
          }
        } else if (segIndex === 0) {
          const stub = src.x + 16;
          newBps[0] = { ...newBps[0], y: src.y + dy };
          newBps.unshift({ x: stub, y: src.y }, { x: stub, y: src.y + dy });
        } else {
          const stub = tgt.x - 16;
          newBps[newBps.length - 1] = { ...newBps[newBps.length - 1], y: tgt.y + dy };
          newBps.push({ x: stub, y: tgt.y + dy }, { x: stub, y: tgt.y });
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
  }, [bps, useRoute, src, tgt, source, sourceHandleId, sourceX, targetX, autoRouteX, isFanOut, screenToFlowPosition, setBps, actions]);

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

  if (bps.length === 0 && !useRoute) {
    const branchX = autoRouteX;
    const [path, lx, ly] = straight
      ? [`M ${src.x},${src.y} L ${tgt.x},${tgt.y}`, (src.x + tgt.x) / 2, src.y] as [string, number, number]
      : getSmoothStepPath({
          sourceX, sourceY: src.y, targetX, targetY: tgt.y, sourcePosition, targetPosition,
          centerX: branchX,
          borderRadius: 0,
        });
    // Keep every logical connection visible while routing is pending, during
    // dragging, or when an old layout leaves insufficient routing space.
    return (
      <>
        <path d={path} fill="none" stroke="var(--bg-primary, #f5f7fa)" strokeWidth={4.4} style={{ pointerEvents: 'none' }} />
        <BaseEdge id={id} path={path} interactionWidth={0} labelX={lx} labelY={ly} label={showLabel ? label : undefined}
          labelStyle={{ fill: '#0f172a', fontSize: 11, fontWeight: 600 }}
          labelBgStyle={{ fill: '#ffffff', fillOpacity: 0.94 }}
          labelBgPadding={[4, 3]} labelBgBorderRadius={3}
          markerEnd={markerEnd} style={edgeStyle} />
        <path d={path} {...hitPathProps} />
      </>
    );
  }

  const pts = edgePoints(src, tgt, bps);
  // Sharp orthogonal corners cannot cut into the keepout at a convex corner.
  const path = polylinePath(pts, 0);
  const mid = polylinePointAt(pts, 0.5);
  return (
    <>
      <path d={path} fill="none" stroke="var(--bg-primary, #f5f7fa)" strokeWidth={4.4} style={{ pointerEvents: 'none' }} />
      <BaseEdge id={id} path={path} interactionWidth={0} labelX={mid.x} labelY={mid.y} label={showLabel ? label : undefined}
        labelStyle={{ fill: '#0f172a', fontSize: 11, fontWeight: 600 }}
        labelBgStyle={{ fill: '#ffffff', fillOpacity: 0.94 }}
        labelBgPadding={[4, 3]} labelBgBorderRadius={3}
        markerEnd={markerEnd} style={edgeStyle} />
      <path d={path} {...hitPathProps} />
      {useRoute && route!.junctions.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={2.5} fill="#334155" style={{ pointerEvents: 'none' }} />
      ))}
      {selected && (
        <BendpointHandles bendpoints={bps}
          onChange={(next) => setBps(orthogonalize(src, tgt, next))}
          onDragEnd={() => actions?.persistBendpoints()} />
      )}
    </>
  );
}
