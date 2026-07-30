import { useState, useCallback, useMemo, Component, type ReactNode } from 'react';
import { useFlowStore } from '../store/flowStore';
import type { ExprNode, AeroCoefficient } from '../types';
import { migrateOldCoefficient } from '../utils/expressionConverter';
import { exprToSegments } from '../utils/exprToFormula';
import ExpressionEditor from './expression/ExpressionEditor';
import TableChart from './expression/TableChart';

// Error boundary
class AeroErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: string }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: '' };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 16, color: '#ef4444', fontSize: 12 }}>
          <p>⚠️ 渲染错误: {this.state.error}</p>
          <button onClick={() => this.setState({ hasError: false, error: '' })}
            style={{ marginTop: 8, padding: '4px 12px', fontSize: 11, cursor: 'pointer',
              background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 4, color: '#ef4444' }}>
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Axis definitions with colors and icons ────────────────────────────────

const AXIS_DEFS: Record<string, { label: string; icon: string; color: string; desc: string }> = {
  LIFT:  { label: '升力', icon: '⬆️', color: '#3b82f6', desc: 'Lift (Z body)' },
  DRAG:  { label: '阻力', icon: '⬅️', color: '#ef4444', desc: 'Drag (X body)' },
  SIDE:  { label: '侧力', icon: '↔️', color: '#f59e0b', desc: 'Side (Y body)' },
  ROLL:  { label: '滚转', icon: '🔄', color: '#8b5cf6', desc: 'Roll moment' },
  PITCH: { label: '俯仰', icon: '🔃', color: '#10b981', desc: 'Pitch moment' },
  YAW:   { label: '偏航', icon: '↩️', color: '#ec4899', desc: 'Yaw moment' },
};

const AXIS_ORDER = ['LIFT', 'DRAG', 'SIDE', 'ROLL', 'PITCH', 'YAW'];

function parseCoefficients(json: string): AeroCoefficient[] {
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr.map((item: any) => {
      if (item.expression) return item as AeroCoefficient;
      return {
        name: item.name || '',
        description: item.description || '',
        axis: item.axis || 'LIFT',
        expression: migrateOldCoefficient(item),
      };
    });
  } catch { return []; }
}

function emptyCoeff(axis = 'LIFT'): AeroCoefficient {
  return { name: '', description: '', axis, expression: { kind: 'value', value: 0 } };
}

function getExprSummary(expr: ExprNode | undefined | null): string {
  if (!expr || !expr.kind) return '?';
  try {
    switch (expr.kind) {
      case 'value': return `= ${expr.value}`;
      case 'property': return `= ${expr.name.split('/').pop()}`;
      case 'function_ref': return `→ ${expr.name.split('/').pop()}`;
      case 'table': return `📊 ${expr.tableType}(${expr.var1.split('/').pop()})`;
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

// ── Main Component ────────────────────────────────────────────────────────

export default function AeroEditor() {
  const { nodes, selectedNodeId, updateNodeParams } = useFlowStore();
  const node = nodes.find(n => n.id === selectedNodeId);
  const rawCoeffs = node?.data?.params?.coefficients || '[]';
  const [coeffs, setCoeffs] = useState<AeroCoefficient[]>(() => parseCoefficients(rawCoeffs));
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [showExprEditor, setShowExprEditor] = useState(false);
  const [previewIdx, setPreviewIdx] = useState<number | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const save = useCallback((updated: AeroCoefficient[]) => {
    setCoeffs(updated);
    if (node) {
      try {
        updateNodeParams(node.id, { coefficients: JSON.stringify(updated) });
      } catch (e) {
        console.warn('[AeroEditor] save error:', e);
      }
    }
  }, [node, updateNodeParams]);

  const addCoeff = (axis?: string) => {
    const c = emptyCoeff(axis);
    c.name = `aero/coefficient/C_${axis?.toLowerCase() || 'new'}`;
    const updated = [...coeffs, c];
    save(updated);
    setEditIdx(updated.length - 1);
    // Expand the group if collapsed
    if (axis) {
      setCollapsedGroups(prev => { const n = new Set(prev); n.delete(axis); return n; });
    }
  };

  const removeCoeff = (idx: number) => {
    const updated = coeffs.filter((_, i) => i !== idx);
    save(updated);
    if (editIdx === idx) setEditIdx(null);
    else if (editIdx !== null && editIdx > idx) setEditIdx(editIdx - 1);
    if (previewIdx === idx) setPreviewIdx(null);
  };

  const updateCoeff = (idx: number, patch: Partial<AeroCoefficient>) => {
    const updated = coeffs.map((c, i) => i === idx ? { ...c, ...patch } : c);
    save(updated);
  };

  const updateExpression = (idx: number, expr: ExprNode) => {
    if (!expr || !expr.kind) return;
    const updated = coeffs.map((c, i) => i === idx ? { ...c, expression: expr } : c);
    save(updated);
  };

  const toggleGroup = (axis: string) => {
    setCollapsedGroups(prev => {
      const n = new Set(prev);
      if (n.has(axis)) n.delete(axis); else n.add(axis);
      return n;
    });
  };

  // Group coefficients by axis
  const grouped = useMemo(() => {
    const groups: Record<string, { coeff: AeroCoefficient; origIdx: number }[]> = {};
    for (const axis of AXIS_ORDER) groups[axis] = [];
    coeffs.forEach((c, i) => {
      const axis = c.axis || 'LIFT';
      if (!groups[axis]) groups[axis] = [];
      groups[axis].push({ coeff: c, origIdx: i });
    });
    return groups;
  }, [coeffs]);

  const current = editIdx !== null ? coeffs[editIdx] : null;

  // Show expression editor
  if (showExprEditor && editIdx !== null && current) {
    return (
      <ExpressionEditor
        expression={current.expression}
        onChange={(expr) => updateExpression(editIdx, expr)}
        onBack={() => setShowExprEditor(false)}
      />
    );
  }

  return (
    <AeroErrorBoundary>
    <div className="aero-editor">
      <div className="ae-header">
        <span className="ae-title">🌊 气动系数</span>
        <span className="ae-count">{coeffs.length} 项</span>
      </div>

      {/* Grouped coefficient list */}
      <div className="ae-groups">
        {AXIS_ORDER.map(axis => {
          const items = grouped[axis] || [];
          const def = AXIS_DEFS[axis];
          const isCollapsed = collapsedGroups.has(axis);
          if (items.length === 0 && !isCollapsed) {
            // Show empty group header with add button
            return (
              <div key={axis} className="ae-group">
                <div className="ae-group-header" style={{ borderLeftColor: def.color }}>
                  <span className="ae-group-icon">{def.icon}</span>
                  <span className="ae-group-label">{def.label}</span>
                  <span className="ae-group-count">0</span>
                  <button className="ae-group-add" onClick={() => addCoeff(axis)} title={`添加${def.label}系数`}>+</button>
                </div>
              </div>
            );
          }
          if (items.length === 0) return null;
          return (
            <div key={axis} className="ae-group">
              <div className="ae-group-header" style={{ borderLeftColor: def.color }}
                onClick={() => toggleGroup(axis)}>
                <span className="ae-group-icon">{def.icon}</span>
                <span className="ae-group-label">{def.label}</span>
                <span className="ae-group-count">{items.length}</span>
                <span className="ae-group-toggle">{isCollapsed ? '▶' : '▼'}</span>
                <button className="ae-group-add" onClick={e => { e.stopPropagation(); addCoeff(axis); }} title={`添加${def.label}系数`}>+</button>
              </div>
              {!isCollapsed && (
                <div className="ae-group-items">
                  {items.map(({ coeff: c, origIdx: i }) => (
                    <div key={i}>
                      <div className={`ae-item ${editIdx === i ? 'active' : ''}`}
                        style={{ borderLeftColor: def.color }}
                        onClick={() => setEditIdx(i)}
                        onDoubleClick={() => { setEditIdx(i); setShowExprEditor(true); }}
                      >
                        <div className="ae-item-info">
                          <span className="ae-item-name">{c.name.split('/').pop() || '(未命名)'}</span>
                          <span className="ae-item-type">{getExprSummary(c.expression)}</span>
                        </div>
                        <div className="ae-item-actions">
                          <button
                            className={`ae-preview-btn ${previewIdx === i ? 'active' : ''}`}
                            onClick={e => { e.stopPropagation(); setPreviewIdx(previewIdx === i ? null : i); }}
                            title="预览公式"
                          >
                            {previewIdx === i ? '▲' : '▼'}
                          </button>
                          <button className="ae-item-del" onClick={e => { e.stopPropagation(); removeCoeff(i); }}>✕</button>
                        </div>
                      </div>
                      {previewIdx === i && (
                        <div className="ae-formula-preview" style={{ borderLeftColor: def.color }}>
                          <FormulaDisplay expr={c.expression} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {coeffs.length === 0 && (
          <div className="ae-empty">
            点击上方 <strong>+</strong> 按力/力矩轴分组添加系数<br />
            <small style={{ color: 'var(--text-muted)' }}>双击系数打开表达式编辑器</small>
          </div>
        )}
      </div>

      {/* Editor panel */}
      {current && editIdx !== null && (
        <div className="ae-editor-panel">
          {/* Group indicator */}
          <div className="ae-panel-group-tag" style={{ background: AXIS_DEFS[current.axis]?.color || '#666' }}>
            {AXIS_DEFS[current.axis]?.icon} {AXIS_DEFS[current.axis]?.label}
          </div>

          <div className="ae-field">
            <label>名称</label>
            <input value={current.name} onChange={e => updateCoeff(editIdx, { name: e.target.value })} placeholder="aero/coefficient/CLalpha" />
          </div>
          <div className="ae-field">
            <label>描述</label>
            <input value={current.description} onChange={e => updateCoeff(editIdx, { description: e.target.value })} placeholder="Lift due to alpha" />
          </div>
          <div className="ae-field">
            <label>力/力矩轴</label>
            <select value={current.axis} onChange={e => updateCoeff(editIdx, { axis: e.target.value })}>
              {AXIS_ORDER.map(a => <option key={a} value={a}>{AXIS_DEFS[a].icon} {a} — {AXIS_DEFS[a].label}</option>)}
            </select>
          </div>

          {/* Expression formula preview */}
          <div className="ae-expr-summary">
            <div className="ae-expr-label">公式预览</div>
            <div className="ae-expr-formula">
              <FormulaDisplay expr={current?.expression} />
            </div>
          </div>

          {/* Open expression editor button */}
          <button className="ae-open-expr-btn" onClick={() => setShowExprEditor(true)}>
            📐 打开表达式编辑器
          </button>

          {/* Quick edit for simple expressions */}
          {current.expression?.kind === 'value' && (
            <div className="ae-quick-edit">
              <label>常数值</label>
              <input
                type="number" step="any"
                value={current.expression.value}
                onChange={e => updateExpression(editIdx, { kind: 'value', value: parseFloat(e.target.value) || 0 })}
              />
            </div>
          )}

          {/* Chart preview for table expressions */}
          {current.expression?.kind === 'table' && (
            <div className="ae-chart-preview">
              <label>📊 数据预览</label>
              <TableChart expr={current.expression} width={270} height={current.expression.tableType === '3D' ? 260 : 170} />
            </div>
          )}

          {/* Chart for product containing a table */}
          {current.expression?.kind === 'product' && (() => {
            try {
              const tableChild = (current.expression as any).children?.find((c: ExprNode) => c?.kind === 'table');
              if (!tableChild) return null;
              return (
                <div className="ae-chart-preview">
                  <label>📊 数据预览</label>
                  <TableChart expr={tableChild} width={270} height={tableChild.tableType === '3D' ? 260 : 170} />
                </div>
              );
            } catch { return null; }
          })()}
        </div>
      )}
    </div>
    </AeroErrorBoundary>
  );
}

// ── Formula Display Component ──────────────────────────────────────────────

function FormulaDisplay({ expr }: { expr: ExprNode | undefined }) {
  if (!expr || !expr.kind) return <span className="formula-empty">未定义</span>;
  try {
    const segments = exprToSegments(expr);
    if (segments.length === 0) return <span className="formula-empty">空表达式</span>;
    return (
      <span className="formula-root">
        {segments.map((seg, i) => (
          <span key={i} className={`formula-seg formula-${seg.type}`}>{seg.text}</span>
        ))}
      </span>
    );
  } catch {
    return <span className="formula-empty">渲染错误</span>;
  }
}
