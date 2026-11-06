import { useCallback, useLayoutEffect, type ReactNode } from 'react';
import { Handle, Position, NodeResizer, NodeToolbar, useReactFlow, useStore, type NodeProps } from '@xyflow/react';
import { useDiagramNodeInternals } from './useDiagramNodeInternals';
import OperatorSymbol from './OperatorSymbol';
import type { ExprTable } from '../../types';
import './operatorBlocks.css';
import { moduleIsDisabled } from '../../utils/disabledXml';

export function DiagramPort({ id, output = false, top = 50, title }: { id: string; output?: boolean; top?: number; title?: string }) {
  return <Handle id={id} type={output ? 'source' : 'target'} position={output ? Position.Right : Position.Left}
    className={`diagram-port ${output ? 'diagram-port-out' : 'diagram-port-in'}`}
    style={{ top: `${top}%` }} title={title} />;
}

export default function OperatorBlock({ node, kind, value, table, inputs, outputs = ['out'], title, children }: {
  node: NodeProps; kind: string; value?: string; table?: ExprTable; inputs: { id: string; title?: string }[];
  outputs?: string[]; title?: string; children?: ReactNode;
}) {
  const { id, selected, data, width, height } = node;
  const resizing = useStore(s => s.nodeLookup.get(id)?.resizing ?? false);
  const { updateNode } = useReactFlow();
  const finishResize = useCallback((_event: unknown, size: { width: number; height: number }) => {
    // updateNode emits a replacement. Explicitly finish resizing so it cannot
    // reintroduce the old flag after NodeResizer's final dimensions event.
    updateNode(id, n => ({ ...n, resizing: false, width: size.width, height: size.height,
      style: { ...n.style, width: size.width, height: size.height },
      data: { ...n.data, manualSize: { width: size.width, height: size.height } } }));
  }, [id, updateNode]);
  const ports = Math.max(inputs.length, outputs.length, 1);
  const minWidth = value && value.length > 9 ? Math.min(184, Math.max(80, value.length * 6 + 24))
    : ['lead_lag_filter', 'lag_filter', 'washout_filter'].includes(kind) ? 88 : 64;
  // 20 flow units per port, with a full pitch above/below the outer ports.
  const minHeight = Math.max(48, (ports + 1) * 20);
  const manual = data.manualSize as { width: number; height: number } | undefined;
  const w = Math.max(minWidth, resizing ? width || minWidth : manual?.width || minWidth);
  const h = Math.max(minHeight, resizing ? height || minHeight : manual?.height || minHeight);
  const portKey = inputs.map(p => p.id).join('|') + outputs.join('|');
  useLayoutEffect(() => {
    if (manual && !resizing && (manual.width < minWidth || manual.height < minHeight)) {
      updateNode(id, n => ({ ...n, width: w, height: h, style: { ...n.style, width: w, height: h },
        data: { ...n.data, manualSize: { width: w, height: h } } }));
    }
  }, [id, manual, minWidth, minHeight, resizing, w, h, updateNode]);
  useDiagramNodeInternals(id, JSON.stringify([w, h, portKey]));
  return <div className={`diagram-block ${selected ? 'selected' : ''} ${data.pendingSync ? 'pending-sync' : ''} ${moduleIsDisabled(data) ? 'module-commented' : ''}`} style={{ width: w, height: h }} title={moduleIsDisabled(data) ? `${title || '模块'}\n已注释；保存并重新加载后停用` : data.pendingSync ? `${title || '运算块'}\n尚未保存到仿真机模型文件` : title}>
    {moduleIsDisabled(data) && <span className="module-commented-badge">已注释</span>}
    {!!(data.disabledInputs as string[] | undefined)?.length && <span className="module-dependency-badge" title={`输入来自已注释模块：${(data.disabledInputs as string[]).join('、')}`}>⚠</span>}
    <NodeResizer isVisible={selected} minWidth={minWidth} minHeight={minHeight} color="#2563eb"
      onResizeEnd={finishResize} />
    {selected && <NodeToolbar isVisible position={Position.Top} offset={12}>
      <button className="diagram-auto-size nodrag" title="按端口数量恢复自动尺寸" onClick={() => updateNode(id, n => ({
        ...n, width: undefined, height: undefined,
        style: { ...n.style, width: undefined, height: undefined }, data: { ...n.data, manualSize: undefined },
      }))}>自动尺寸</button>
    </NodeToolbar>}
    <div className="diagram-symbol-center"><OperatorSymbol kind={kind} value={value} table={table} /></div>
    {inputs.map((p, i) => <DiagramPort key={p.id} id={p.id} top={(i + 1) * 100 / (inputs.length + 1)} title={p.title} />)}
    {outputs.map((port, i) => <DiagramPort key={port} id={port} output top={(i + 1) * 100 / (outputs.length + 1)} />)}
    {children}
  </div>;
}
