import { useState } from 'react';
import { useFlowStore } from '../store/flowStore';
import { getComponentDef } from '../utils/componentDefs';
import { getUnitOptions, convertUnit, formatValue } from '../utils/unitConverter';
import type { ParamDef, ExprNode } from '../types';
import SubFileEditor from './SubFileEditor';
import AeroEditor from './AeroEditor';
import TableChart from './expression/TableChart';
import ExpressionEditor from './expression/ExpressionEditor';
import ModuleExpressionCanvas, { type ModuleExpression } from './expression/ModuleExpressionCanvas';

// Normalize param value: could be a plain number or { value, unit }
function getNumVal(p: any): number {
  if (typeof p === 'number') return p;
  if (p && typeof p === 'object' && 'value' in p) return Number(p.value) || 0;
  return 0;
}

function getUnitStr(p: any, fallback: string): string {
  if (p && typeof p === 'object' && 'unit' in p && p.unit) return p.unit;
  return fallback;
}

export default function PropertyPanel() {
  const { nodes, selectedNodeId, updateNodeParams, removeNode, setSelectedNode, setFocusedNodeId, editingSubFileId } = useFlowStore();
  const [sysEditingExpr, setSysEditingExpr] = useState<{ chIdx: number; itemIdx: number } | null>(null);
  const [editingCompProp, setEditingCompProp] = useState<{ chIdx: number; itemIdx: number; field: string } | null>(null);
  const [canvasView, setCanvasView] = useState<
    | { title: string; mode?: 'expr'; expressions: ModuleExpression[]; onChange: (id: string, expr: ExprNode) => void }
    | { title: string; mode: 'signal'; channels: any[]; topLevelProps: string[]; onChannelsChange: (channels: any[]) => void }
    | null
  >(null);

  if (editingSubFileId) return <SubFileEditor />;

  // Module-level Simulink-style block canvas (full screen overlay)
  if (canvasView) {
    return (
      <div className="property-panel">
        <h3>属性 Properties</h3>
        {'expressions' in canvasView ? (
          <ModuleExpressionCanvas
            expressions={canvasView.expressions}
            onChange={canvasView.onChange}
            onBack={() => setCanvasView(null)}
            title={canvasView.title}
          />
        ) : (
          <ModuleExpressionCanvas
            mode="signal"
            channels={canvasView.channels}
            topLevelProps={canvasView.topLevelProps}
            onChannelsChange={canvasView.onChannelsChange}
            onBack={() => setCanvasView(null)}
            title={canvasView.title}
          />
        )}
      </div>
    );
  }

  const node = nodes.find(n => n.id === selectedNodeId);

  // System expression editor overlay
  if (sysEditingExpr && (node?.data.componentType === 'system' || node?.data.componentType === 'flight_control')) {
    try {
      const channels = JSON.parse(node.data.params.channels || '[]');
      const ch = channels[sysEditingExpr.chIdx];
      const item = ch?.items?.[sysEditingExpr.itemIdx];
      if (item?.expression) {
        return (
          <div className="property-panel">
            <h3>属性 Properties</h3>
            <div style={{ padding: '4px 0', fontSize: 11, color: 'var(--text-muted)' }}>
              {item.type}: {item.name}
            </div>
            <ExpressionEditor
              expression={item.expression}
              onChange={(expr) => {
                const updated = channels.map((c: any, ci: number) => {
                  if (ci !== sysEditingExpr.chIdx) return c;
                  const items = c.items.map((it: any, ii: number) =>
                    ii === sysEditingExpr.itemIdx ? { ...it, expression: expr } : it
                  );
                  return { ...c, items };
                });
                updateNodeParams(node.id, { channels: JSON.stringify(updated) });
              }}
              onBack={() => setSysEditingExpr(null)}
            />
          </div>
        );
      }
    } catch { /* ignore */ }
  }

  // Component prop expression editor overlay (sensor input, lag, noise, gain, etc.)
  if (editingCompProp && (node?.data.componentType === 'system' || node?.data.componentType === 'flight_control')) {
    try {
      const channels = JSON.parse(node.data.params.channels || '[]');
      const ch = channels[editingCompProp.chIdx];
      const item = ch?.items?.[editingCompProp.itemIdx];
      const fieldData = item?.componentProps?.[editingCompProp.field];
      if (fieldData) {
        // Convert componentProp value to ExprNode
        const val = fieldData.value ?? '';
        const isProperty = typeof val === 'string' && val.includes('/') && !val.startsWith('0');
        const exprNode: any = isProperty
          ? { kind: 'property', name: val }
          : { kind: 'value', value: parseFloat(val) || 0 };
        const attrEntries = Object.entries(fieldData.attrs || {});
        return (
          <div className="property-panel">
            <h3>属性 Properties</h3>
            <div style={{ padding: '4px 0', fontSize: 11, color: 'var(--text-muted)' }}>
              {item.type}: {item.name} → {editingCompProp.field}
              {attrEntries.length > 0 && (
                <span style={{ marginLeft: 8, color: '#d97706' }}>
                  [{attrEntries.map(([k, v]) => `${k}=${v}`).join(', ')}]
                </span>
              )}
            </div>
            <ExpressionEditor
              expression={exprNode}
              onChange={(expr) => {
                // Convert ExprNode back to componentProp value
                let newVal: string;
                if (expr.kind === 'property') {
                  newVal = expr.name || '';
                } else if (expr.kind === 'value') {
                  newVal = String(expr.value);
                } else {
                  newVal = exprToString(expr);
                }
                const newProps = { ...item.componentProps };
                newProps[editingCompProp.field] = { ...newProps[editingCompProp.field], value: newVal };
                const updated = channels.map((c: any, ci: number) => {
                  if (ci !== editingCompProp.chIdx) return c;
                  const items = c.items.map((it: any, ii: number) =>
                    ii === editingCompProp.itemIdx ? { ...it, componentProps: newProps } : it
                  );
                  return { ...c, items };
                });
                updateNodeParams(node.id, { channels: JSON.stringify(updated) });
                setEditingCompProp(null);
              }}
              onBack={() => setEditingCompProp(null)}
            />
          </div>
        );
      }
    } catch { /* ignore */ }
  }

  if (!node) {
    return (
      <div className="property-panel">
        <h3>属性 Properties</h3>
        <p className="no-selection">选择一个节点查看属性</p>
      </div>
    );
  }

  const def = getComponentDef(node.data.componentType);
  if (!def) return null;

  if (node.data.componentType === 'aero_coefficients') {
    return (
      <div className="property-panel">
        <h3>属性 Properties</h3>
        <div className="prop-header">
          <span className="prop-type-badge" style={{ background: def.color }}>
            {def.icon} {def.label}
          </span>
          <button className="delete-btn" onClick={() => { removeNode(node.id); setSelectedNode(null); }}>
            🗑️ 删除
          </button>
        </div>
        <div className="field-row">
          <label>名称</label>
          <input
            type="text"
            value={node.data.label}
            onChange={e => {
              useFlowStore.setState({
                nodes: useFlowStore.getState().nodes.map(n =>
                  n.id === node.id ? { ...n, data: { ...n.data, label: e.target.value } } : n
                ),
              });
            }}
          />
        </div>
        <div className="prop-divider" />
        <AeroEditor />
      </div>
    );
  }

  const handleChange = (key: string, value: any) => {
    updateNodeParams(node.id, { [key]: value });
  };

  // Handle unit change for number fields: convert the value
  const handleUnitChange = (key: string, newUnit: string, oldUnit: string) => {
    const raw = node.data.params[key] ?? 0;
    const oldVal = getNumVal(raw);
    const newVal = convertUnit(oldVal, oldUnit, newUnit);
    // Store as { value, unit } format
    handleChange(key, { value: newVal, unit: newUnit });
  };

  // Handle value change for number fields
  const handleNumChange = (key: string, newVal: number, currentUnit: string) => {
    const raw = node.data.params[key];
    if (raw && typeof raw === 'object' && 'unit' in raw) {
      // Already in { value, unit } format — keep it
      handleChange(key, { value: newVal, unit: raw.unit });
    } else {
      // Plain number — just update the number
      handleChange(key, newVal);
    }
  };

  // Handle unit change for location/vector3 fields
  const handleLocUnitChange = (key: string, newUnit: string, oldUnit: string) => {
    const loc = node.data.params[key] || { x: 0, y: 0, z: 0 };
    const oldX = typeof loc.x === 'number' ? loc.x : 0;
    const oldY = typeof loc.y === 'number' ? loc.y : 0;
    const oldZ = typeof loc.z === 'number' ? loc.z : 0;
    handleChange(key, {
      x: convertUnit(oldX, oldUnit, newUnit),
      y: convertUnit(oldY, oldUnit, newUnit),
      z: convertUnit(oldZ, oldUnit, newUnit),
      unit: newUnit,
    });
  };

  const renderField = (key: string, paramDef: ParamDef) => {
    const raw = node.data.params[key] ?? paramDef.default;

    switch (paramDef.type) {
      case 'number': {
        const numVal = getNumVal(raw);
        const currentUnit = getUnitStr(raw, paramDef.unit || '');
        const unitOptions = currentUnit ? getUnitOptions(currentUnit) : [];
        return (
          <div key={key} className="field-row">
            <label>{paramDef.label}</label>
            <div className="field-input-row">
              <input
                type="number"
                value={formatValue(numVal)}
                step="any"
                onChange={e => handleNumChange(key, parseFloat(e.target.value) || 0, currentUnit)}
              />
              {unitOptions.length > 1 ? (
                <select
                  className="unit-select"
                  value={currentUnit}
                  onChange={e => handleUnitChange(key, e.target.value, currentUnit)}
                  title="切换单位"
                >
                  {unitOptions.map(u => (
                    <option key={u.value} value={u.value}>{u.value}</option>
                  ))}
                </select>
              ) : currentUnit ? (
                <span className="unit-label" title={unitOptions[0]?.label}>{currentUnit}</span>
              ) : null}
            </div>
          </div>
        );
      }
      case 'string':
        return (
          <div key={key} className="field-row">
            <label>{paramDef.label}</label>
            <input
              type="text"
              value={raw}
              onChange={e => handleChange(key, e.target.value)}
            />
          </div>
        );
      case 'select': {
        const selectLabels: Record<string, string> = {
          piston: '🔧 活塞 Piston',
          turbine: '🔥 涡轮 Turbine',
          turboprop: '🔥 涡桨 Turboprop',
          rocket: '🚀 火箭 Rocket',
          electric: '⚡ 电动 Electric',
          brushless_dc: '⚡ 无刷直流 BLDC',
        };
        return (
          <div key={key} className="field-row">
            <label>{paramDef.label}</label>
            <select value={raw} onChange={e => handleChange(key, e.target.value)}>
              {paramDef.options?.map(opt => (
                <option key={opt} value={opt}>{selectLabels[opt] || opt}</option>
              ))}
            </select>
          </div>
        );
      }
      case 'location':
      case 'vector3': {
        const loc = raw || { x: 0, y: 0, z: 0 };
        const labels = paramDef.type === 'location' ? ['Y', 'X', 'Z'] : ['Roll', 'Pitch', 'Yaw'];
        const axisKeys = paramDef.type === 'location' ? ['y', 'x', 'z'] : ['x', 'y', 'z'];
        const currentUnit = loc.unit || paramDef.unit || '';
        const unitOptions = currentUnit ? getUnitOptions(currentUnit) : [];
        return (
          <div key={key} className="field-row">
            <label>{paramDef.label}</label>
            <div className="location-inputs">
              {labels.map((l, i) => {
                const axis = axisKeys[i];
                const axisVal = typeof loc[axis] === 'number' ? loc[axis] : 0;
                return (
                  <div key={axis} className="axis-input">
                    <span className="axis-label">{l}</span>
                    <input
                      type="number"
                      value={formatValue(axisVal)}
                      step="any"
                      onChange={e => {
                        const newLoc = { ...loc, [axis]: parseFloat(e.target.value) || 0 };
                        handleChange(key, newLoc);
                      }}
                    />
                  </div>
                );
              })}
              {unitOptions.length > 1 ? (
                <select
                  className="unit-select unit-select-loc"
                  value={currentUnit}
                  onChange={e => handleLocUnitChange(key, e.target.value, currentUnit)}
                  title="切换单位"
                >
                  {unitOptions.map(u => (
                    <option key={u.value} value={u.value}>{u.value}</option>
                  ))}
                </select>
              ) : currentUnit ? (
                <span className="unit-label">{currentUnit}</span>
              ) : null}
            </div>
          </div>
        );
      }
      default:
        return null;
    }
  };

  return (
    <div className="property-panel">
      <h3>属性 Properties</h3>
      <div className="prop-header">
        <span className="prop-type-badge" style={{ background: def.color }}>
          {def.icon} {def.label}
        </span>
        <button className="delete-btn" onClick={() => { removeNode(node.id); setSelectedNode(null); }}>
          🗑️ 删除
        </button>
      </div>
      <div className="field-row">
        <label>名称</label>
        <input
          type="text"
          value={node.data.label}
          onChange={e => {
            useFlowStore.setState({
              nodes: useFlowStore.getState().nodes.map(n =>
                n.id === node.id ? { ...n, data: { ...n.data, label: e.target.value } } : n
              ),
            });
          }}
        />
      </div>
      <div className="prop-divider" />
      {Object.entries(def.params)
        .filter(([key]) => {
          // For engine/propeller: skip location/orient if no actual value
          if (node.data.componentType === 'engine' || node.data.componentType === 'propeller') {
            if ((key === 'location' || key === 'orient') && !node.data.params[key]) return false;
            if (key === 'feed' && !node.data.params[key]) return false;
          }
          return true;
        })
        .map(([key, paramDef]) => renderField(key, paramDef))}

      {/* Show editable content for system / flight_control nodes */}
      {(node.data.componentType === 'system' || node.data.componentType === 'flight_control') && node.data.params.channels && (() => {
        try {
          const channels = JSON.parse(node.data.params.channels);
          if (!Array.isArray(channels) || channels.length === 0) return null;

          const updateChannels = (updated: any[]) => {
            updateNodeParams(node.id, { channels: JSON.stringify(updated) });
          };

          const updateItem = (chIdx: number, itemIdx: number, patch: any) => {
            const updated = channels.map((ch: any, ci: number) => {
              if (ci !== chIdx) return ch;
              const items = ch.items.map((item: any, ii: number) =>
                ii === itemIdx ? { ...item, ...patch } : item
              );
              return { ...ch, items };
            });
            updateChannels(updated);
          };

          const deleteItem = (chIdx: number, itemIdx: number) => {
            const updated = channels.map((ch: any, ci: number) => {
              if (ci !== chIdx) return ch;
              return { ...ch, items: ch.items.filter((_: any, ii: number) => ii !== itemIdx) };
            });
            updateChannels(updated);
          };

          const addItem = (chIdx: number) => {
            const updated = channels.map((ch: any, ci: number) => {
              if (ci !== chIdx) return ch;
              return { ...ch, items: [...ch.items, { type: 'function', name: 'new_function', expression: { kind: 'value', value: 0 } }] };
            });
            updateChannels(updated);
          };

          const editExpr = (chIdx: number, itemIdx: number) => {
            // Store editing state for expression editor
            setSysEditingExpr({ chIdx, itemIdx });
          };

          return (
            <>
              <div className="prop-divider" />
              <div className="prop-merged-section">
                <div className="prop-merged-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>🔗 控制通道 ({channels.length})</span>
                <button
                  className="ae-open-expr-btn"
                  style={{ margin: 0, padding: '2px 10px', fontSize: 11 }}
                  onClick={() => setFocusedNodeId(node!.id)}
                  title="在主界面画布中查看/编辑该模块内部的信号流图"
                >🔍 进入模块画布</button>
              </div>
                {channels.map((ch: any, i: number) => (
                  <SystemChannelEditor
                    key={i}
                    channel={ch}
                    channelIndex={i}
                    onUpdateItem={updateItem}
                    onDeleteItem={deleteItem}
                    onEditExpr={editExpr}
                    onAddItem={addItem}
                    onEditCompProp={(chIdx, itemIdx, field) => setEditingCompProp({ chIdx, itemIdx, field })}
                  />
                ))}
              </div>
            </>
          );
        } catch { return null; }
      })()}

      {/* Editable merged file params for engine/propeller nodes */}
      {(node.data.componentType === 'engine' || node.data.componentType === 'propeller') && node.data.params._source_file && (() => {
        const skip = new Set(['file', 'feed', 'location', 'orient', '_source_file', '_root_tag',
          'name', 'ixx_unit', 'diameter_unit', '_tables']);
        const p = node.data.params;
        const merged = Object.entries(p).filter(([k]) => !skip.has(k) && typeof p[k] === 'number');
        const rawTables = p._tables;
        let tables: any[] = [];
        try {
          tables = typeof rawTables === 'string' ? JSON.parse(rawTables) : (rawTables || []);
        } catch { tables = []; }
        if (merged.length === 0 && tables.length === 0) return null;
        const icon = node.data.componentType === 'engine' ? '⚙️' : '🔄';
        return (
          <>
            <div className="prop-divider" />
            <div className="prop-merged-section">
              <div className="prop-merged-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span>{icon} 引用文件属性 ({p._source_file})</span>
              {(() => {
                const tblExprs: ModuleExpression[] = Array.isArray(p.tables)
                  ? p.tables.map((t: any, ti: number) => ({ id: `t${ti}`, name: t.name, expression: t.expression }))
                  : [];
                if (tblExprs.length === 0) return null;
                return (
                  <button
                    className="ae-open-expr-btn"
                    style={{ margin: 0, padding: '2px 10px', fontSize: 11 }}
                    onClick={() => setCanvasView({
                      title: '推进系数据表',
                      expressions: tblExprs,
                      onChange: (id, expr) => {
                        const idx = Number(id.slice(1));
                        const cur = Array.isArray(p.tables) ? p.tables.map((t: any) => ({ ...t })) : [];
                        if (cur[idx]) { cur[idx] = { ...cur[idx], expression: expr }; updateNodeParams(node!.id, { tables: cur }); }
                      },
                    })}
                  >📐 模块画布</button>
                );
              })()}
            </div>
              {merged.map(([k, v]) => (
                <div key={k} className="field-row">
                  <label>{k}</label>
                  <div className="field-input-row">
                    <input
                      type="number"
                      step="any"
                      value={v}
                      onChange={e => {
                        const newVal = parseFloat(e.target.value) || 0;
                        updateNodeParams(node.id, { [k]: newVal });
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
            {/* Table data display and edit */}
            {tables.length > 0 && tables.map((tbl: any, ti: number) => (
              <TableDataEditor
                key={ti}
                table={tbl}
                onUpdate={(updated) => {
                  const newTables = [...tables];
                  newTables[ti] = updated;
                  updateNodeParams(node.id, { _tables: JSON.stringify(newTables) });
                }}
              />
            ))}
          </>
        );
      })()}

      {/* Universal table data display for ANY node type */}
      {!(node.data.componentType === 'engine' || node.data.componentType === 'propeller') && (() => {
        const rawTables = node.data.params._tables;
        let tables: any[] = [];
        try {
          tables = typeof rawTables === 'string' ? JSON.parse(rawTables) : (rawTables || []);
        } catch { tables = []; }
        if (tables.length === 0) return null;
        return (
          <>
            <div className="prop-divider" />
            {tables.map((tbl: any, ti: number) => (
              <TableDataEditor
                key={ti}
                table={tbl}
                onUpdate={(updated) => {
                  const newTables = [...tables];
                  newTables[ti] = updated;
                  updateNodeParams(node.id, { _tables: JSON.stringify(newTables) });
                }}
              />
            ))}
          </>
        );
      })()}
    </div>
  );
}

// ── Table Data Editor Component ────────────────────────────────────────────

function TableDataEditor({ table, onUpdate }: { table: any; onUpdate: (t: any) => void }) {
  const [expanded, setExpanded] = useState(false);
  const data: number[][] = table.data || [];
  if (data.length === 0) return null;

  // Determine if 1D (2 columns) or 2D
  const cols = data[0]?.length || 0;
  const is1D = cols === 2;

  // Build ExprNode for chart preview
  const chartExpr = is1D ? {
    kind: 'table' as const,
    tableType: '1D',
    var1: table.name || 'x',
    breakpoints1: data.map(r => r[0]),
    data: data.map(r => [r[1]]),
  } : null;

  const handleCellEdit = (row: number, col: number, val: string) => {
    const newData = data.map((r, ri) => ri === row ? [...r] : [...r]);
    newData[row][col] = parseFloat(val) || 0;
    onUpdate({ ...table, data: newData });
  };

  const handleAddRow = () => {
    const lastRow = data[data.length - 1] || [0, 0];
    const newRow = lastRow.map((v, i) => i === 0 ? v + 0.05 : v);
    onUpdate({ ...table, data: [...data, newRow] });
  };

  const handleDeleteRow = (idx: number) => {
    const newData = data.filter((_, i) => i !== idx);
    onUpdate({ ...table, data: newData });
  };

  return (
    <div className="prop-merged-section" style={{ marginTop: 8 }}>
      <div className="prop-merged-title" style={{ cursor: 'pointer' }} onClick={() => setExpanded(!expanded)}>
        📊 {table.name} ({data.length} 行 × {cols} 列) {expanded ? '▼' : '▶'}
      </div>
      {/* Chart preview */}
      {chartExpr && !expanded && (
        <div style={{ padding: '4px 0' }}>
          <TableChart expr={chartExpr as any} width={260} height={140} />
        </div>
      )}
      {expanded && (
        <>
          {/* Chart */}
          {chartExpr && (
            <div style={{ padding: '4px 0', borderBottom: '1px solid var(--border)', marginBottom: 6 }}>
              <TableChart expr={chartExpr as any} width={260} height={150} />
            </div>
          )}
          {/* Editable data table */}
          <div className="table-data-grid" style={{ maxHeight: 200, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr>
                  {is1D ? (
                    <>
                      <th style={thStyle}>{table.name || 'x'}</th>
                      <th style={thStyle}>f(x)</th>
                    </>
                  ) : (
                    data[0]?.map((_, ci) => (
                      <th key={ci} style={thStyle}>col {ci}</th>
                    ))
                  )}
                  <th style={{ ...thStyle, width: 24 }}></th>
                </tr>
              </thead>
              <tbody>
                {data.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((val, ci) => (
                      <td key={ci} style={{ padding: 1, border: '1px solid var(--border)' }}>
                        <input
                          type="number"
                          step="any"
                          value={val}
                          onChange={e => handleCellEdit(ri, ci, e.target.value)}
                          style={cellInputStyle}
                        />
                      </td>
                    ))}
                    <td style={{ padding: 0, textAlign: 'center' }}>
                      <button
                        onClick={() => handleDeleteRow(ri)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', fontSize: 10, padding: 2 }}
                        title="删除行"
                      >✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            onClick={handleAddRow}
            style={{ marginTop: 4, padding: '2px 8px', fontSize: 11, cursor: 'pointer',
              background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 3, width: '100%' }}
          >+ 添加行</button>
        </>
      )}
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: '2px 4px', border: '1px solid var(--border)', background: 'var(--bg-secondary)',
  fontWeight: 500, fontSize: 10, textAlign: 'center',
};

const cellInputStyle: React.CSSProperties = {
  width: '100%', border: 'none', background: 'transparent', textAlign: 'right',
  padding: '2px 4px', fontSize: 11, outline: 'none',
};

// ── System Channel Editor Component ────────────────────────────────────────

const TYPE_ICONS: Record<string, string> = {
  function: 'ƒ', kinematic: '⚙', switch: '🔀', pid: '📐',
  filter: '🔧', gain: '📈', integrator: '∫', summer: 'Σ',
  sensor: '📡', actuator: '🎯', channel: '📂',
};

function getExprSummary(expr: any): string {
  if (!expr || !expr.kind) return '';
  try {
    switch (expr.kind) {
      case 'value': return `= ${expr.value}`;
      case 'property': return `= ${expr.name?.split('/').pop() || expr.name}`;
      case 'function_ref': return `→ ${expr.name?.split('/').pop() || expr.name}`;
      case 'table': return `📊 ${expr.tableType}(${expr.var1?.split('/').pop()})`;
      case 'product': return `×(${expr.children?.length || 0})`;
      case 'sum': return `+(${expr.children?.length || 0})`;
      case 'difference': return 'a−b';
      case 'quotient': return 'a÷b';
      case 'pow': return 'a^b';
      case 'sin': case 'cos': case 'tan':
      case 'asin': case 'acos': case 'atan':
      case 'sqrt': case 'abs': case 'exp':
        return `${expr.kind}()`;
      case 'ifthen': return 'if…';
      case 'switch': return `sw(${expr.cases?.length || 0})`;
      default: return '?';
    }
  } catch { return '?'; }
}

function SystemChannelEditor({
  channel, channelIndex, onUpdateItem, onDeleteItem, onEditExpr, onAddItem, onEditCompProp,
}: {
  channel: any; channelIndex: number;
  onUpdateItem: (chIdx: number, itemIdx: number, patch: any) => void;
  onDeleteItem: (chIdx: number, itemIdx: number) => void;
  onEditExpr: (chIdx: number, itemIdx: number) => void;
  onAddItem: (chIdx: number) => void;
  onEditCompProp: (chIdx: number, itemIdx: number, field: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const items = channel.items || [];

  const typeColor = (type: string) => {
    const colors: Record<string, string> = {
      function: '#3b82f6', kinematic: '#8b5cf6', switch: '#f59e0b',
      pid: '#10b981', filter: '#6366f1', sensor: '#ec4899',
    };
    return colors[type] || '#64748b';
  };

  return (
    <div style={{ marginBottom: 4 }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px', cursor: 'pointer',
          background: 'var(--bg-secondary)', borderRadius: 4, fontSize: 12 }}
        onClick={() => setExpanded(!expanded)}
      >
        <span style={{ fontSize: 10 }}>{expanded ? '▼' : '▶'}</span>
        <span>📂</span>
        <span style={{ fontWeight: 500 }}>{channel.name || `Channel ${channelIndex + 1}`}</span>
        <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>({items.length})</span>
      </div>
      {expanded && (
        <div style={{ paddingLeft: 12, marginTop: 2 }}>
          {items.map((item: any, j: number) => {
            const summary = getExprSummary(item.expression);
            // Extract properties from expression tree for inline editing
            const props = extractProperties(item.expression);
            return (
              <div key={j} style={{ marginBottom: 2 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 0',
                  borderBottom: '1px solid var(--border-light, #eee)', fontSize: 11 }}>
                  <span style={{ color: typeColor(item.type), fontWeight: 600, minWidth: 16, textAlign: 'center' }}>
                    {TYPE_ICONS[item.type] || '•'}
                  </span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 10, minWidth: 50 }}>{item.type}</span>
                  <input
                    type="text"
                    value={item.name || ''}
                    onChange={e => onUpdateItem(channelIndex, j, { name: e.target.value })}
                    style={{ flex: 1, border: 'none', background: 'transparent', fontSize: 11,
                      outline: 'none', padding: '1px 2px', color: 'var(--text-primary)', minWidth: 0 }}
                    placeholder="名称"
                  />
                  {summary && (
                    <span style={{ color: '#6366f1', fontSize: 10, maxWidth: 80, overflow: 'hidden',
                      textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 }} title={summary}>
                      {summary}
                    </span>
                  )}
                  <button
                    onClick={() => onEditExpr(channelIndex, j)}
                    style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 3,
                      cursor: 'pointer', fontSize: 10, padding: '1px 4px', color: '#3b82f6', flexShrink: 0 }}
                    title="编辑表达式"
                  >📐</button>
                  <button
                    onClick={() => onDeleteItem(channelIndex, j)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444',
                      fontSize: 10, padding: '1px 3px', flexShrink: 0 }}
                    title="删除"
                  >✕</button>
                </div>
                {/* Inline property editor */}
                {props.length > 0 && (
                  <div style={{ paddingLeft: 20, paddingBottom: 2 }}>
                    {props.map((prop, pi) => (
                      <div key={pi} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, padding: '1px 0' }}>
                        <span style={{ color: '#059669', minWidth: 55 }}>📌 {prop.role}</span>
                        <input
                          type="text"
                          value={prop.value}
                          onChange={e => {
                            const newExpr = updatePropertyInExpr(item.expression, prop.role, e.target.value);
                            if (newExpr) onUpdateItem(channelIndex, j, { expression: newExpr });
                          }}
                          style={{ flex: 1, border: '1px solid var(--border-light, #e5e7eb)', borderRadius: 2,
                            background: 'var(--bg-primary, #fff)', fontSize: 10, padding: '1px 4px',
                            outline: 'none', color: 'var(--text-primary)', fontFamily: 'monospace' }}
                        />
                      </div>
                    ))}
                  </div>
                )}
                {/* Component-specific properties (sensor, actuator, etc.) */}
                {item.componentProps && Object.keys(item.componentProps).length > 0 && (
                  <div style={{ paddingLeft: 20, paddingBottom: 2 }}>
                    {Object.entries(item.componentProps).map(([field, fieldData]: [string, any]) => {
                      if (field === 'properties' && Array.isArray(fieldData)) {
                        return fieldData.map((p: string, pi: number) => (
                          <div key={`prop-${pi}`} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, padding: '1px 0' }}>
                            <span style={{ color: '#059669', minWidth: 55 }}>📌 property</span>
                            <input type="text" value={p} readOnly
                              style={{ flex: 1, border: '1px solid var(--border-light, #e5e7eb)', borderRadius: 2,
                                background: 'var(--bg-secondary)', fontSize: 10, padding: '1px 4px',
                                outline: 'none', color: 'var(--text-primary)', fontFamily: 'monospace' }} />
                          </div>
                        ));
                      }
                      const val = fieldData?.value ?? '';
                      const attrs = fieldData?.attrs || {};
                      const attrStr = Object.keys(attrs).length > 0
                        ? ` [${Object.entries(attrs).map(([k, v]) => `${k}=${v}`).join(', ')}]`
                        : '';
                      return (
                        <div key={field} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, padding: '1px 0' }}>
                          <span style={{ color: '#d97706', minWidth: 55, fontWeight: 500 }}>{field}</span>
                          <input
                            type="text"
                            value={val}
                            onChange={e => {
                              const newProps = { ...item.componentProps };
                              newProps[field] = { ...newProps[field], value: e.target.value };
                              onUpdateItem(channelIndex, j, { componentProps: newProps });
                            }}
                            title={attrStr || undefined}
                            style={{ flex: 1, border: '1px solid var(--border-light, #e5e7eb)', borderRadius: 2,
                              background: 'var(--bg-primary, #fff)', fontSize: 10, padding: '1px 4px',
                              outline: 'none', color: 'var(--text-primary)', fontFamily: 'monospace' }}
                          />
                          {attrStr && (
                            <span style={{ color: 'var(--text-muted)', fontSize: 9, flexShrink: 0 }}>{attrStr}</span>
                          )}
                          <button
                            onClick={() => onEditCompProp(channelIndex, j, field)}
                            style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 3,
                              cursor: 'pointer', fontSize: 9, padding: '0 3px', color: '#3b82f6', flexShrink: 0 }}
                            title="用表达式编辑器打开"
                          >📐</button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {items.length === 0 && (
            <div style={{ color: 'var(--text-muted)', fontSize: 10, padding: '4px 0' }}>空通道</div>
          )}
          <button
            onClick={() => onAddItem(channelIndex)}
            style={{ marginTop: 4, padding: '2px 8px', fontSize: 10, cursor: 'pointer',
              background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 3, width: '100%' }}
          >+ 添加组件</button>
        </div>
      )}
    </div>
  );
}

// Extract editable properties from an expression tree
function extractProperties(expr: any): { role: string; value: string }[] {
  if (!expr || !expr.kind) return [];
  const props: { role: string; value: string }[] = [];
  function walk(node: any, depth: number = 0) {
    if (!node) return;
    if (node.kind === 'property' && node.name) {
      props.push({ role: 'property', value: node.name });
    }
    if (node.kind === 'value' && depth > 0) {
      props.push({ role: 'value', value: String(node.value) });
    }
    if (node.children) {
      for (const child of node.children) walk(child, depth + 1);
    }
    if (node.operand) walk(node.operand, depth + 1);
  }
  walk(expr);
  return props;
}

// Convert an expression tree back to a string representation
function exprToString(expr: any): string {
  if (!expr || !expr.kind) return '0';
  switch (expr.kind) {
    case 'value': return String(expr.value);
    case 'property': return expr.name || '';
    case 'product': {
      const parts = (expr.children || []).map(exprToString);
      return parts.join(' * ');
    }
    case 'sum': {
      const parts = (expr.children || []).map(exprToString);
      return parts.join(' + ');
    }
    case 'difference': {
      const parts = (expr.children || []).map(exprToString);
      return parts.join(' - ');
    }
    case 'quotient': {
      const parts = (expr.children || []).map(exprToString);
      return parts.join(' / ');
    }
    case 'pow': {
      const parts = (expr.children || []).map(exprToString);
      return `pow(${parts.join(', ')})`;
    }
    case 'sin': case 'cos': case 'tan':
    case 'asin': case 'acos': case 'atan':
    case 'sqrt': case 'abs': case 'exp':
      return `${expr.kind}(${exprToString(expr.children?.[0])})`;
    case 'ifthen':
      return `if(${exprToString(expr.children?.[0])}, ${exprToString(expr.children?.[1])}, ${exprToString(expr.children?.[2])})`;
    default: return '?';
  }
}

// Update a property or value in an expression tree
function updatePropertyInExpr(expr: any, role: string, newVal: string): any {
  if (!expr || !expr.kind) return expr;
  let found = false;
  function walk(node: any, depth: number = 0): any {
    if (!node || found) return node;
    if (node.kind === 'property' && depth > 0 && role === 'property') {
      found = true;
      return { ...node, name: newVal };
    }
    if (node.kind === 'value' && depth > 0 && role === 'value') {
      found = true;
      return { ...node, value: parseFloat(newVal) || 0 };
    }
    if (node.children) {
      return { ...node, children: node.children.map((c: any) => walk(c, depth + 1)) };
    }
    if (node.operand) {
      return { ...node, operand: walk(node.operand, depth + 1) };
    }
    return node;
  }
  return walk(expr);
}
