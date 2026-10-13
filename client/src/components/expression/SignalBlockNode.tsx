import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import OperatorBlock from './OperatorBlock';
import type { ExprTable } from '../../types';

function SignalBlockNode(node: NodeProps) {
  const d = node.data as any;
  const functional = ['function', 'fcs_function'].includes(d.itemType);
  let kind = functional ? d.expression?.kind || 'function' : d.itemType;
  const scalar = (v: any) => v && typeof v === 'object' ? v.value ?? v['#text'] : v;
  const bound = (v: any) => {
    const text = String(scalar(v) ?? '').trim();
    return text || undefined;
  };
  const clipMin = bound(d.cliptoMin ?? d.compProps?.clipto_min);
  const clipMax = bound(d.cliptoMax ?? d.compProps?.clipto_max);
  const range = `[${clipMin ?? '−∞'}, ${clipMax ?? '∞'}]`;
  // Simplify only a plain clipping actuator. Additional parameters (including
  // property-driven or unknown ones) retain the general actuator label.
  const clipOnly = kind === 'actuator' && clipMin !== undefined && clipMax !== undefined &&
    Object.keys(d.compProps || {}).every(key =>
      ['input', 'inputs', 'output', 'properties', 'clipto_min', 'clipto_max', 'description'].includes(key));
  let value: string | undefined;
  if (clipOnly) {
    kind = 'saturation';
    value = range;
  }
  if (kind === 'pure_gain' || kind === 'scheduled_gain') value = String(scalar(d.compProps?.gain) ?? '1');
  if (kind === 'constant') value = String(scalar(d.compProps?.constant) ?? '0');
  if (kind === 'value') value = String(d.expression.value);
  if (kind === 'property' || kind === 'function_ref') value = d.expression?.name?.split('/').pop();
  const name = d.name || d.outputSignal || d.meta?.label;
  const title = d.kind === 'tablePreview'
    ? `${name}\n${(d.inputs || []).join(', ')} → 查表结果（双击查看数据）`
    : d.itemType === 'actuator'
    ? `${name || '执行器'}\n${clipOnly ? `限幅 ${range}` : '执行器：按配置处理输入信号'}` : name;
  const inputIndices: number[] = kind === 'constant' ? []
    : d.diagramInputIndices || (d.inputs || []).map((_: string, i: number) => i);
  const table = d.expression?.kind === 'table' ? d.expression as ExprTable : undefined;
  return <OperatorBlock node={node} kind={kind} value={value} table={table} title={title}
    inputs={inputIndices.map((i: number) => ({ id: `in-${i}`, title: d.inputs[i] }))}>
    {!clipOnly && (clipMin !== undefined || clipMax !== undefined) &&
      <span className="diagram-clip">{range}</span>}
  </OperatorBlock>;
}
export default memo(SignalBlockNode);
