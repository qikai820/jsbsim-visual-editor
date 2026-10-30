import FloatInput from '../FloatInput';
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
  const update = (patch: Partial<typeof expr>) => onChange({ ...expr, ...patch });

  return (
    <div className="expr-table-editor">
      <div className="expr-bp-field">
        <label>表格维度</label>
        <select value={expr.tableType} onChange={e => update({ tableType: e.target.value as any })}>
          <option value="1D">一维表 (行)</option>
          <option value="2D">二维表 (行×列)</option>
          <option value="3D">三维表 (行×列×表)</option>
        </select>
      </div>
      <div className="expr-bp-field">
        <label>自变量 1 (行)</label>
        <SignalPathInput value={expr.var1} onChange={var1 => update({ var1 })} />
      </div>
      {(expr.tableType === '2D' || expr.tableType === '3D') && (
        <div className="expr-bp-field">
          <label>自变量 2 (列)</label>
          <SignalPathInput value={expr.var2} onChange={var2 => update({ var2 })} />
        </div>
      )}
      {expr.tableType === '3D' && (
        <div className="expr-bp-field">
          <label>自变量 3 (表)</label>
          <SignalPathInput value={expr.var3} onChange={var3 => update({ var3 })} />
        </div>
      )}

      {/* Compact table data display */}
      <div className="expr-table-data">
        <label>数据 ({expr.breakpoints1.length} 行)</label>
        <div className="expr-table-scroll">
          <table className="expr-mini-table">
            <tbody>
              {expr.data.map((row, ri) => (
                <tr key={ri}>
                  <td className="expr-mini-bp">
                    <FloatInput value={expr.breakpoints1[ri] ?? 0}
                      onValueChange={value => {
                        const bp = [...expr.breakpoints1]; bp[ri] = value;
                        update({ breakpoints1: bp });
                      }} />
                  </td>
                  {row.map((val, ci) => (
                    <td key={ci}>
                      <FloatInput value={val}
                        onValueChange={value => {
                          const data = expr.data.map(r => [...r]);
                          data[ri][ci] = value;
                          update({ data });
                        }} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button className="expr-bp-add-row" onClick={() => {
          const cols = expr.data[0]?.length || 1;
          update({
            data: [...expr.data, new Array(cols).fill(0)],
            breakpoints1: [...expr.breakpoints1, 0],
          });
        }}>+ 行</button>
      </div>
    </div>
  );
}
