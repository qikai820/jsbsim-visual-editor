import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { ExprNode } from '../../types';
import type { BlockDef } from '../../utils/expressionConverter';

interface FunctionBlockData {
  exprNode: ExprNode;
  blockDef: BlockDef;
  inputCount: number;
  blockId: string;
}

const INPUT_LABELS: Record<string, string[]> = {
  difference: ['a', 'b'],
  quotient: ['num', 'den'],
  pow: ['base', 'exp'],
  atan2: ['y', 'x'],
  ifthen: ['cond', 'then', 'else'],
  gt: ['a', 'b'], lt: ['a', 'b'], ge: ['a', 'b'],
  le: ['a', 'b'], eq: ['a', 'b'], nq: ['a', 'b'],
};

function getSummary(expr: ExprNode): string {
  switch (expr.kind) {
    case 'value': return String(expr.value);
    case 'property': return expr.name.split('/').pop() || expr.name;
    case 'function_ref': return expr.name.split('/').pop() || expr.name;
    case 'table': return `${expr.tableType}(${expr.var1.split('/').pop() || '?'})`;
    default: return '';
  }
}

function FunctionBlockNode({ data, selected }: NodeProps) {
  const { exprNode, blockDef, inputCount } = data as unknown as FunctionBlockData;
  const summary = getSummary(exprNode);
  const isLeaf = inputCount === 0;

  return (
    <div
      className={`fn-block fn-block-${blockDef.category} ${selected ? 'selected' : ''}`}
      style={{ '--block-color': blockDef.color } as React.CSSProperties}
    >
      {/* Input handles */}
      {Array.from({ length: inputCount }, (_, i) => {
        const labels = INPUT_LABELS[exprNode.kind];
        const label = labels ? labels[i] : (blockDef.inputCount === 'variable' ? String(i + 1) : undefined);
        const topPct = inputCount === 1 ? 50 : (i + 1) * (100 / (inputCount + 1));
        return (
          <Handle
            key={`in-${i}`}
            type="target"
            position={Position.Left}
            id={`in-${i}`}
            style={{ top: `${topPct}%`, background: blockDef.color }}
            title={label || `Input ${i + 1}`}
          >
            {label && <span className="fn-port-label">{label}</span>}
          </Handle>
        );
      })}

      {/* Block body */}
      <div className="fn-block-header" style={{ background: blockDef.color }}>
        <span className="fn-block-icon">{blockDef.icon}</span>
        <span className="fn-block-label">{blockDef.label}</span>
      </div>

      {summary && (
        <div className="fn-block-summary" title={summary}>
          {summary}
        </div>
      )}

      {/* Variable arity: add port button */}
      {blockDef.inputCount === 'variable' && (
        <div className="fn-block-add-port" data-action="add-input">
          +
        </div>
      )}

      {/* Output handle */}
      <Handle
        type="source"
        position={Position.Right}
        id="out-0"
        style={{ top: '50%', background: blockDef.color }}
      />
    </div>
  );
}

export default memo(FunctionBlockNode);
