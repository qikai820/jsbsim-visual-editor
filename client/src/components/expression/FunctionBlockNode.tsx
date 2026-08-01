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
  // In signal-flow expand mode, property/function_ref leaves act as signal inlets
  // (they receive the owning function's input signal from an external wire).
  const inSignalFlow = !!(data as any).inSignalFlow;
  const isSignalLeaf = inSignalFlow && (exprNode.kind === 'property' || exprNode.kind === 'function_ref');
  const exprName = (data as any).exprName as string | undefined;
  const isRoot = (data as any).isExprRoot as boolean | undefined;

  return (
    <div
      className={`fn-block fn-block-${blockDef.category} ${selected ? 'selected' : ''} ${isRoot ? 'fn-block-root' : ''}`}
      style={{ '--block-color': blockDef.color } as React.CSSProperties}
    >
      {/* Expression name label for module-canvas root nodes */}
      {exprName && (
        <div className="fn-expr-name" title={exprName}>{exprName}</div>
      )}

      {/* Input handles */}
      {Array.from({ length: inputCount }, (_, i) => {
        const labels = INPUT_LABELS[exprNode.kind];
        // Simulink Sum: mark each input port with a '+' sign.
        const label = exprNode.kind === 'sum' ? '+' : (labels ? labels[i] : (blockDef.inputCount === 'variable' ? String(i + 1) : undefined));
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

      {/* Simulink-style operator body: big symbol (or leaf value) */}
      <div className={`fn-op-body ${isLeaf ? 'fn-op-leaf' : ''}`}>
        {isLeaf ? (
          <span className="fn-op-leafval" title={summary}>{summary}</span>
        ) : (
          <span className="fn-op-symbol" style={{ color: blockDef.color }}>{blockDef.icon}</span>
        )}
      </div>

      {/* Variable arity: add port button */}
      {blockDef.inputCount === 'variable' && (
        <div className="fn-block-add-port" data-action="add-input">
          +
        </div>
      )}

      {/* Signal inlet for expanded-in-canvas leaves (property / function_ref) */}
      {isSignalLeaf && (
        <Handle
          type="target"
          position={Position.Left}
          id="in-signal"
          className="fn-inlet-handle"
          style={{ top: '50%', background: '#10b981' }}
        />
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
