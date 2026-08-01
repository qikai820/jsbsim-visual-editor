import { useRef } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { Bendpoint } from './bendpoints';

interface Props {
  bendpoints: Bendpoint[];
  onChange: (next: Bendpoint[]) => void;
  onDragEnd?: () => void;
}

// Draggable waypoint circles rendered inside the edge's SVG viewport (flow coords).
// pointerdown must stopPropagation so it doesn't trigger the canvas box-selection;
// pointer capture keeps the drag alive during fast moves. Double-click deletes a point.
export default function BendpointHandles({ bendpoints, onChange, onDragEnd }: Props) {
  const { screenToFlowPosition } = useReactFlow();
  const dragIdx = useRef<number | null>(null);

  const down = (i: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    dragIdx.current = i;
  };
  const move = (i: number) => (e: React.PointerEvent) => {
    if (dragIdx.current !== i) return;
    const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const next = bendpoints.slice();
    next[i] = p;
    onChange(next);
  };
  const up = () => {
    if (dragIdx.current !== null) {
      dragIdx.current = null;
      onDragEnd?.();
    }
  };
  const dbl = (i: number) => (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(bendpoints.filter((_, j) => j !== i));
  };

  return (
    <g className="bp-handles">
      {bendpoints.map((bp, i) => (
        <circle
          key={i}
          cx={bp.x}
          cy={bp.y}
          r={5}
          className="bp-handle"
          onPointerDown={down(i)}
          onPointerMove={move(i)}
          onPointerUp={up}
          onDoubleClick={dbl(i)}
        />
      ))}
    </g>
  );
}
