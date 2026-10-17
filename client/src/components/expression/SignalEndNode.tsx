import { memo, useLayoutEffect } from 'react';
import { useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { DiagramPort } from './OperatorBlock';

interface SignalEndData {
  signalRole: 'source' | 'sink';
  signalName: string;
  [key: string]: any;
}

function shortName(s: string): string {
  if (!s) return '—';
  return s.split('/').pop() || s;
}

function SignalEndNode({ id, data, selected }: NodeProps) {
  const d = data as SignalEndData;
  const isSource = d.signalRole === 'source';
  const color = isSource ? '#10b981' : '#f59e0b';
  const updateInternals = useUpdateNodeInternals();
  useLayoutEffect(() => { updateInternals(id); }, [id, d.signalName, isSource, updateInternals]);

  return (
    <div
      className={`sig-end ${isSource ? 'sig-end-source' : 'sig-end-sink'} ${selected ? 'selected' : ''}`}
      style={{ '--block-color': color } as React.CSSProperties}
      title={isSource && d.initialValue !== undefined ? undefined : d.signalName}
    >
      {!isSource && (
        <DiagramPort id="in" />
      )}
      <span className="sig-end-label">{shortName(d.signalName)}</span>
      {isSource && d.initialValue !== undefined && <span className="sig-end-tooltip" role="tooltip">
        <strong>{d.signalName}</strong>
        <span>初始值 <b>{d.initialValue}</b></span>
      </span>}
      {isSource && (
        <DiagramPort id="out" output />
      )}
    </div>
  );
}

export default memo(SignalEndNode);
