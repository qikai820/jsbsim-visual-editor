import { useState } from 'react';
import FloatInput from '../FloatInput';
import LutTablePreview from './LutTablePreview';
import { axisCount, formatTableNumber, tableRange } from '../../utils/tableData';
import type { ExprNode } from '../../types';
import { BLOCK_DEFS } from '../../utils/expressionConverter';
import TableChart from './TableChart';
import SignalPathInput from '../SignalPathInput';

export interface BlockPropertyPanelProps {
  expr: ExprNode;
  onChange: (expr: ExprNode) => void;
  onDelete: () => void;
  isRoot: boolean;
}

export function BlockPropertyPanel({ expr, onChange, onDelete, isRoot }: BlockPropertyPanelProps) {
  const def = BLOCK_DEFS[expr.kind];

  return (
    <div className="expr-block-props">
      <div className="expr-bp-header">
        <span className="expr-bp-badge" style={{ background: def?.color || '#666' }}>
          {def?.icon} {def?.label || expr.kind}
        </span>
        {!isRoot && (
          <button className="expr-bp-delete" onClick={onDelete}>🗑️</button>
        )}
      </div>

      {/* Value block */}
      {expr.kind === 'value' && (
        <div className="expr-bp-field">
          <label>数值</label>
          <FloatInput
            value={expr.value}
            onValueChange={value => onChange({ ...expr, value })}
          />
        </div>
      )}

      {/* Property block */}
      {expr.kind === 'property' && (
        <div className="expr-bp-field">
          <label>属性名</label>
          <SignalPathInput
            value={expr.name}
            onChange={name => onChange({ ...expr, name })}
            placeholder="aero/alpha-rad"
          />
        </div>
      )}

      {/* Function reference */}
      {expr.kind === 'function_ref' && (
        <div className="expr-bp-field">
          <label>函数名</label>
          <SignalPathInput
            value={expr.name}
            onChange={name => onChange({ ...expr, name })}
            placeholder="aero/function/kCDge"
          />
        </div>
      )}

      {/* Table block */}
      {expr.kind === 'table' && (
        <>
          <TableEditor expr={expr} onChange={onChange} />
          <div className="expr-table-chart">
            <label>📊 数据图表</label>
            <TableChart expr={expr} width={230} height={expr.tableType === '3D' ? 280 : 180} />
          </div>
        </>
      )}

      {/* Variable arity: add/remove children */}
      {(expr.kind === 'product' || expr.kind === 'sum') && (
        <div className="expr-bp-actions">
          <button
            className="expr-bp-add-child"
            onClick={() => {
              const children = [...(expr as any).children, { kind: 'value', value: 0 } as ExprNode];
              onChange({ ...expr, children } as any);
            }}
          >
            + 添加输入
          </button>
          {(expr as any).children.length > 1 && (
            <button
              className="expr-bp-remove-child"
              onClick={() => {
                const children = (expr as any).children.slice(0, -1);
                onChange({ ...expr, children } as any);
              }}
            >
              − 移除末输入
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Table Editor (inline) ───────────────────────────────────────────────────

interface TableEditorProps {
  expr: ExprNode & { kind: 'table' };
  onChange: (expr: ExprNode) => void;
}

export function TableEditor({ expr, onChange }: TableEditorProps) {
  const [open, setOpen] = useState(false);
  const [min, max] = tableRange(expr);
  return <div className="expr-table-editor">
    <div className="lut-compact-summary"><strong>{expr.tableType} · {axisCount(expr)} 个自变量</strong>
      {expr.breakpoints1.length} 行{expr.tableType !== '1D' && ` × ${expr.breakpoints2.length} 列`}{expr.tableType === '3D' && ` × ${expr.breakpoints3.length} 层`}<br />
      输出 {formatTableNumber(min)} ～ {formatTableNumber(max)}
    </div>
    <button type="button" className="lut-open-editor" onClick={() => setOpen(true)}>▦ 3D 预览与编辑数据</button>
    {open && <LutTablePreview title="插值表" expression={expr} onChange={onChange} onClose={() => setOpen(false)} />}
  </div>;
}
