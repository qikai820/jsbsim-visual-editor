import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import OperatorBlock from './OperatorBlock';

function FunctionBlockNode(node: NodeProps) {
  const { exprNode, blockDef, inputCount, inSignalFlow } = node.data as any;
  const isSignalLeaf = inSignalFlow && ['property', 'function_ref'].includes(exprNode.kind);
  const inputs = Array.from({ length: inputCount }, (_, i) => ({ id: `in-${i}`, title: `输入 ${i + 1}` }));
  if (isSignalLeaf) inputs.push({ id: 'in-signal', title: exprNode.name });
  const value = exprNode.kind === 'value' ? String(exprNode.value)
    : ['property', 'function_ref'].includes(exprNode.kind) ? exprNode.name?.split('/').pop() : undefined;
  return <OperatorBlock node={node} kind={exprNode.kind} value={value}
    table={exprNode.kind === 'table' ? exprNode : undefined} inputs={inputs} outputs={['out-0']}
    title={exprNode.name || blockDef.label}>
    {blockDef.inputCount === 'variable' && <div className="fn-block-add-port" data-action="add-input" title="增加输入端口">+</div>}
  </OperatorBlock>;
}
export default memo(FunctionBlockNode);
