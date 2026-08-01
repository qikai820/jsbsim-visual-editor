import type { ExprNode } from '../../types';
import { BLOCK_DEFS } from '../../utils/expressionConverter';
import TableChart from './TableChart';

export const COMMON_PROPERTIES = [
  'aero/alpha-rad', 'aero/beta-rad', 'aero/qbar-psf',
  'fcs/elevator-pos-rad', 'fcs/elevator-pos-deg',
  'fcs/aileron-pos-rad', 'fcs/aileron-pos-deg',
  'fcs/rudder-pos-rad', 'fcs/rudder-pos-deg',
  'fcs/flap-pos-deg', 'fcs/speedbrake-pos-rad',
  'velocities/mach', 'velocities/vc-kts',
  'metrics/Sw-sqft', 'metrics/bw-ft', 'metrics/cbar-b-ft',
  'aero/h_b-mac-ft', 'aero/stall-hyst-norm',
  'aero/bi2vel', 'aero/ci2vel', 'aero/cl-squared',
  'atmosphere/rho-slugs_ft3',
  'velocities/p-aero-rad_sec', 'velocities/q-aero-rad_sec', 'velocities/r-aero-rad_sec',
  'velocities/u-aero-fps', 'velocities/v-aero-fps', 'velocities/w-aero-fps',
];

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
          <input
            type="number"
            step="any"
            value={expr.value}
            onChange={e => onChange({ ...expr, value: parseFloat(e.target.value) || 0 })}
          />
        </div>
      )}

      {/* Property block */}
      {expr.kind === 'property' && (
        <div className="expr-bp-field">
          <label>属性名</label>
          <input
            type="text"
            list="prop-suggestions"
            value={expr.name}
            onChange={e => onChange({ ...expr, name: e.target.value })}
            placeholder="aero/alpha-rad"
          />
          <datalist id="prop-suggestions">
            {COMMON_PROPERTIES.map(p => <option key={p} value={p} />)}
          </datalist>
        </div>
      )}

      {/* Function reference */}
      {expr.kind === 'function_ref' && (
        <div className="expr-bp-field">
          <label>函数名</label>
          <input
            type="text"
            value={expr.name}
            onChange={e => onChange({ ...expr, name: e.target.value })}
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
        <input type="text" list="prop-suggestions" value={expr.var1}
          onChange={e => update({ var1: e.target.value })} />
      </div>
      {(expr.tableType === '2D' || expr.tableType === '3D') && (
        <div className="expr-bp-field">
          <label>自变量 2 (列)</label>
          <input type="text" list="prop-suggestions" value={expr.var2}
            onChange={e => update({ var2: e.target.value })} />
        </div>
      )}
      {expr.tableType === '3D' && (
        <div className="expr-bp-field">
          <label>自变量 3 (表)</label>
          <input type="text" list="prop-suggestions" value={expr.var3}
            onChange={e => update({ var3: e.target.value })} />
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
                    <input type="number" step="any" value={expr.breakpoints1[ri] ?? 0}
                      onChange={e => {
                        const bp = [...expr.breakpoints1]; bp[ri] = parseFloat(e.target.value) || 0;
                        update({ breakpoints1: bp });
                      }} />
                  </td>
                  {row.map((val, ci) => (
                    <td key={ci}>
                      <input type="number" step="any" value={val}
                        onChange={e => {
                          const data = expr.data.map(r => [...r]);
                          data[ri][ci] = parseFloat(e.target.value) || 0;
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
