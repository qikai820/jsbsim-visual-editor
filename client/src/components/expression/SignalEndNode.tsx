import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

interface SignalEndData {
  signalRole: 'source' | 'sink';
  signalName: string;
  [key: string]: any;
}

function shortName(s: string): string {
  if (!s) return '—';
  return s.split('/').pop() || s;
}

function SignalEndNode({ data, selected }: NodeProps) {
  const d = data as SignalEndData;
  const isSource = d.signalRole === 'source';
  const color = isSource ? '#10b981' : '#f59e0b';

  return (
    <div
      className={`sig-end ${isSource ? 'sig-end-source' : 'sig-end-sink'} ${selected ? 'selected' : ''}`}
      style={{ '--block-color': color } as React.CSSProperties}
      title={d.signalName}
    >
      {!isSource && (
        <Handle type="target" position={Position.Left} id="in" style={{ background: color }} />
      )}
      <span className="sig-end-icon">{isSource ? '▶' : '■'}</span>
      <span className="sig-end-label">{shortName(d.signalName)}</span>
      <span className="sig-end-role">{isSource ? '输入信号' : '输出信号'}</span>
      {isSource && (
        <Handle type="source" position={Position.Right} id="out" style={{ background: color }} />
      )}
    </div>
  );
}

export default memo(SignalEndNode);
