import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ExprNode, ExprTable } from '../../types';
import TableChart from './TableChart';
import FloatInput from '../FloatInput';
import SignalPathInput from '../SignalPathInput';
import { AXIS_NAMES, axisBreakpoints, axisCount, axisLabel, axisVariable, convertTableDimension, expressionTables,
  formatTableNumber, pasteTableValues, resizeTableAxis, setAxisBreakpoint, setTableValue, tableRange, tableSlice, tableValue,
  validateTable, valueColor, type TableAxis, type TablePoint } from '../../utils/tableData';
import './tableWorkspace.css';

interface LutTablePreviewProps {
  title: string;
  expression?: ExprNode;
  onChange?: (expression: ExprNode) => void;
  onClose: () => void;
}
const fmt = (value: number | undefined) => value === undefined || !Number.isFinite(value) ? '—' : formatTableNumber(value);

function TableWorkspace({ table, onChange }: { table: ExprTable; onChange?: (table: ExprTable) => void }) {
  const [fixedAxis, setFixedAxis] = useState<TableAxis>(2);
  const [selected, setSelected] = useState<TablePoint>([0, 0, 0]);
  const [mode, setMode] = useState<'surface' | 'heatmap'>('surface');
  const [pasteMessage, setPasteMessage] = useState('');
  const grid = useRef<HTMLDivElement>(null);
  const dimensions = axisCount(table);
  const point = selected.map((index, axis) => Math.max(0, Math.min(index,
    (axis < dimensions ? axisBreakpoints(table, axis as TableAxis).length : 1) - 1))) as TablePoint;
  const slice = point[fixedAxis];
  const view = useMemo(() => tableSlice(table, fixedAxis, slice), [table, fixedAxis, slice]);
  const [min, max] = useMemo(() => tableRange(table), [table]);
  const activeAxes = ([0, 1, 2] as TableAxis[]).slice(0, dimensions);
  const selectPoint = (next: TablePoint, scroll = false) => {
    setSelected(next);
    if (scroll) requestAnimationFrame(() => grid.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  };
  const changeSlice = (index: number) => {
    const next = [...point] as TablePoint; next[fixedAxis] = Math.max(0, Math.min(axisBreakpoints(table, fixedAxis).length - 1, index));
    setSelected(next);
  };
  const resizeAxis = (axis: TableAxis, remove = false) => {
    if (!onChange) return;
    const next = resizeTableAxis(table, axis, remove ? point[axis] : undefined);
    const nextPoint = [...point] as TablePoint;
    nextPoint[axis] = remove ? Math.min(point[axis], axisBreakpoints(next, axis).length - 1) : axisBreakpoints(next, axis).length - 1;
    setSelected(nextPoint); onChange(next); setPasteMessage('');
  };
  const errors = validateTable(table);
  return <>
    <div className="lut-workspace-summary">
      <div className="lut-workspace-dimension"><span>{table.tableType}</span><div><b>{dimensions === 1 ? '一维曲线' : dimensions === 2 ? '二维插值曲面' : '三维数据 · 切片曲面'}</b>
        <small>{activeAxes.map(axis => `${axisBreakpoints(table, axis).length} ${AXIS_NAMES[axis]}`).join(' × ')}<i> / </i>{table.data.reduce((sum, row) => sum + row.length, 0)} 个数值</small></div></div>
      <div className="lut-workspace-range"><span>输出范围</span><b>{fmt(min)} <i>—</i> {fmt(max)}</b></div>
    </div>
    <details className="lut-axis-config">
      <summary>变量与维度 <span>{activeAxes.map(axis => `${AXIS_NAMES[axis]}: ${axisLabel(table, axis)}`).join(' · ')}</span></summary>
      <div className="lut-axis-fields"><label>表格维度<select aria-label="表格维度" disabled={!onChange} value={table.tableType}
        onChange={event => {
          onChange?.(convertTableDimension(table, event.target.value as ExprTable['tableType'], point));
          setSelected([point[0], 0, 0]); setFixedAxis(2);
        }}><option value="1D">1D · 一个自变量</option><option value="2D">2D · 两个自变量</option><option value="3D">3D · 三个自变量</option></select></label>
        {activeAxes.map(axis => <label key={axis}>{AXIS_NAMES[axis]}自变量
          <SignalPathInput value={axisVariable(table, axis)} readOnly={!onChange} placeholder={`输入${AXIS_NAMES[axis]}自变量路径`}
            onChange={value => onChange?.({ ...table, [`var${axis + 1}`]: value })} />
        </label>)}
      </div>
      {onChange && <p>升维时复制已有数值；降维时保留当前选中层，降为 1D 时保留当前列。点击“重置修改”可恢复。</p>}
    </details>
    {dimensions === 3 && <div className="lut-workspace-slice">
      <label>固定轴<select aria-label="固定切片轴" value={fixedAxis} onChange={e => setFixedAxis(Number(e.target.value) as TableAxis)}>
        {activeAxes.map(axis => <option key={axis} value={axis}>{AXIS_NAMES[axis]} · {axisLabel(table, axis)}</option>)}
      </select></label>
      <div className="lut-slice-navigation"><button type="button" aria-label="上一个切片" disabled={slice <= 0} onClick={() => changeSlice(slice - 1)}>‹</button>
        <select aria-label="当前切片" value={slice} onChange={e => changeSlice(Number(e.target.value))}>
          {axisBreakpoints(table, fixedAxis).map((value, index) => <option key={index} value={index}>{axisLabel(table, fixedAxis)} = {fmt(value)}</option>)}
        </select>
        <button type="button" aria-label="下一个切片" disabled={slice >= axisBreakpoints(table, fixedAxis).length - 1} onClick={() => changeSlice(slice + 1)}>›</button>
      </div>
      <input type="range" aria-label="切片位置" min={0} max={Math.max(0, axisBreakpoints(table, fixedAxis).length - 1)} value={slice}
        onChange={e => changeSlice(Number(e.target.value))} />
      <span className="lut-slice-count">{slice + 1} / {axisBreakpoints(table, fixedAxis).length}</span>
      {onChange && <label className="lut-slice-value">断点<FloatInput formatValue={formatTableNumber} key={`${fixedAxis}-${slice}`} aria-label="当前切片断点" value={axisBreakpoints(table, fixedAxis)[slice]}
        onValueChange={value => onChange(setAxisBreakpoint(table, fixedAxis, slice, value))} /></label>}
    </div>}
    <div className="lut-workspace-content">
      <section className="lut-workspace-visual">
        <div className="lut-workspace-panel-heading"><div><b>{dimensions === 1 ? '插值曲线' : '曲面与数值分布'}</b><span>{dimensions === 3 ? `${axisLabel(table, fixedAxis)} = ${fmt(axisBreakpoints(table, fixedAxis)[slice])}` : '数据修改后实时更新'}</span></div>
          {dimensions > 1 && <div className="lut-view-tabs" role="group" aria-label="图形显示方式">
            <button type="button" aria-pressed={mode === 'surface'} onClick={() => setMode('surface')}>3D 曲面</button>
            <button type="button" aria-pressed={mode === 'heatmap'} onClick={() => setMode('heatmap')}>热力图</button>
          </div>}
        </div>
        <TableChart expr={table} width={660} height={390} fixedAxis={fixedAxis} slice={slice} selected={point} mode={mode} onSelect={next => selectPoint(next, true)} />
        <p className="lut-chart-explanation">{dimensions === 1 ? '横轴是自变量，纵轴是输出；点击曲线上的数据点定位单元格。'
          : `${dimensions === 3 ? '固定一个自变量后，' : ''}底面两轴是自变量，曲面高度和颜色均表示输出值。`}</p>
      </section>
      <section className="lut-workspace-grid-panel">
        <div className="lut-workspace-panel-heading"><div><b>断点与输出值</b><span>{onChange ? '编辑单元格 · 支持从 Excel 粘贴数值区域' : '点击单元格可在图中定位'}</span></div><span className="lut-grid-size">{view.rows.length} × {view.columns.length}</span></div>
        <div className="lut-workspace-grid-scroll" ref={grid}>
          <table className="lut-edit-grid"><thead><tr><th className="lut-grid-corner"><b>行 ↓ {axisLabel(table, view.rowAxis ?? 0)}</b>
            <span>{view.columnAxis === undefined ? '输出 f(x)' : `列 → ${axisLabel(table, view.columnAxis)}`}</span></th>
            {view.columnAxis === undefined ? <th>输出值</th> : view.columns.map((bp, col) => <th key={col}>
              {onChange ? <FloatInput formatValue={formatTableNumber} aria-label={`列断点 ${col + 1}`} value={bp} onValueChange={value => onChange(setAxisBreakpoint(table, view.columnAxis!, col, value))} /> : fmt(bp)}
            </th>)}
          </tr></thead><tbody>{view.rows.map((bp, row) => <tr key={row}><th>
            {onChange ? <FloatInput formatValue={formatTableNumber} aria-label={`行断点 ${row + 1}`} value={bp} onValueChange={value => onChange(setAxisBreakpoint(table, view.rowAxis, row, value))} /> : fmt(bp)}
          </th>{view.columns.map((_, col) => {
            const cellPoint = view.pointAt(row, col), value = tableValue(table, cellPoint), isSelected = point.every((v, i) => v === cellPoint[i]);
            return <td key={col} data-selected={isSelected} style={{ backgroundColor: value === undefined ? '#f1f5f9' : valueColor(value, min, max, .13) }}
              onClick={() => selectPoint(cellPoint)} title={activeAxes.map(axis => `${axisLabel(table, axis)} = ${fmt(axisBreakpoints(table, axis)[cellPoint[axis]])}`).join('\n')}>
              {onChange ? <FloatInput formatValue={formatTableNumber} key={cellPoint.join('-')} data-lut-cell={`${row}-${col}`} aria-label={`输出 行 ${row + 1} 列 ${col + 1}`} value={value}
                onFocus={() => selectPoint(cellPoint)} onValueChange={next => onChange(setTableValue(table, cellPoint, next))}
                onPaste={event => {
                  const text = event.clipboardData.getData('text/plain');
                  if (!/[\t\n;,]/.test(text)) return;
                  event.preventDefault();
                  try { onChange(pasteTableValues(table, fixedAxis, slice, row, col, text)); setPasteMessage('数值区域已粘贴，其他切片保持原值。'); }
                  catch (error) { setPasteMessage((error as Error).message); }
                }} /> : <button type="button" onClick={() => selectPoint(cellPoint)}>{fmt(value)}</button>}
            </td>;
          })}</tr>)}</tbody></table>
        </div>
        {onChange && <div className="lut-grid-actions">{activeAxes.map(axis => <div key={axis}><span>{AXIS_NAMES[axis]}断点</span>
          <button type="button" aria-label={`添加${AXIS_NAMES[axis]}断点`} onClick={() => resizeAxis(axis)}>＋</button>
          <button type="button" aria-label={`删除选中${AXIS_NAMES[axis]}断点`} disabled={axisBreakpoints(table, axis).length <= 1} onClick={() => resizeAxis(axis, true)}>−</button>
        </div>)}</div>}
        {onChange && <p className="lut-grid-help">表头是共享断点。增删行、列会同步所有层；新增断点延用边界值，删除作用于当前选中坐标。</p>}
        {pasteMessage && <p className="lut-paste-message" role="status">{pasteMessage}</p>}
      </section>
    </div>
    <div className="lut-selected-point"><span>当前坐标</span>{activeAxes.map(axis => <span key={axis} title={axisVariable(table, axis)}>{axisLabel(table, axis)}<b>{fmt(axisBreakpoints(table, axis)[point[axis]])}</b></span>)}
      <span className="lut-selected-output">输出<b>{fmt(tableValue(table, point))}</b></span></div>
    {onChange && errors.length > 0 && <div className="lut-validation" role="alert">{errors.join('；')}</div>}
  </>;
}

export default function LutTablePreview({ title, expression, onChange, onClose }: LutTablePreviewProps) {
  const [initialExpression] = useState(expression);
  const tables = useMemo(() => initialExpression ? expressionTables(initialExpression) : [], [initialExpression]);
  const [tableIndex, setTableIndex] = useState(0);
  const [drafts, setDrafts] = useState<Record<number, ExprTable>>({});
  const [message, setMessage] = useState('');
  const [resetVersion, setResetVersion] = useState(0);
  const dialog = useRef<HTMLElement>(null);
  const titleId = useId();
  const selectedTable = drafts[tableIndex] || tables[tableIndex]?.table;
  const dirty = Object.entries(drafts).some(([index, table]) => JSON.stringify(table) !== JSON.stringify(tables[Number(index)].table));
  const errors = Object.values(drafts).flatMap(validateTable);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  if (!selectedTable) return null;
  const apply = () => {
    if (!onChange || !initialExpression) return;
    if (dialog.current?.querySelector('[aria-invalid="true"]')) { setMessage('有尚未提交的无效数值，请修正或按 Esc 恢复原值。'); return; }
    if (errors.length) return;
    let next = initialExpression;
    for (const [index, table] of Object.entries(drafts)) next = expressionTables(next)[Number(index)].replace(table);
    onChange(next); onClose();
  };
  return createPortal(<div className="lut-preview-overlay lut-workspace-overlay" onPointerDown={event => event.stopPropagation()}>
    <section ref={dialog} className="lut-preview-dialog lut-workspace-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); if (dirty) setMessage('修改尚未应用；点击“取消”放弃，或点击“应用到模型”保存。'); else onClose(); }
        if (event.key === 'Tab') {
          const elements = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]') || [])].filter(el => el.getClientRects().length);
          const first = elements[0], last = elements[elements.length - 1];
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <header className="lut-workspace-header"><div><span className="lut-header-icon">▦</span><div><b id={titleId}>插值表{onChange ? '编辑器' : '预览'}</b><span title={title}>{title}</span></div></div><button type="button" aria-label="关闭插值表" onClick={onClose}>×</button></header>
      {tables.length > 1 && <div className="lut-table-switcher"><span>函数中的插值表</span>{tables.map((entry, index) => <button type="button" key={index} aria-pressed={tableIndex === index}
        onClick={() => { setTableIndex(index); setMessage(''); }}>{index + 1}. {entry.table.tableType} · {axisLabel(entry.table, 0)}</button>)}</div>}
      <div className="lut-workspace-body"><TableWorkspace key={`${tableIndex}-${resetVersion}`} table={selectedTable}
        onChange={onChange ? table => { setDrafts(current => ({ ...current, [tableIndex]: table })); setMessage(''); } : undefined} /></div>
      <footer className="lut-workspace-footer"><span role="status">{message || (dirty ? '有未应用的修改 · 图表已实时更新' : onChange ? '编辑后应用到模型；文件保存沿用主界面保存操作。' : '只读预览')}</span>
        {onChange && <button type="button" onClick={() => { setDrafts({}); setResetVersion(current => current + 1); setMessage(''); }}>重置修改</button>}
        <button type="button" onClick={onClose}>{onChange ? '取消' : '关闭'}</button>
        {onChange && <button type="button" className="lut-apply-button" disabled={!dirty || errors.length > 0} onClick={apply}>应用到模型</button>}
      </footer>
    </section>
  </div>, document.body);
}
